/**
 * `create_matrix_room` delivery-action bodies.
 *
 * SECURITY: this writes CENTRAL DB state (a messaging group, a wiring, a
 * destination) and asks the homeserver to create a room and invite people —
 * things a confined container is otherwise barred from. The container's MCP
 * tool is untrusted (it can be bypassed by writing the outbound row directly),
 * so authorization is enforced host-side: the delivery registry wraps this
 * action with the guard, whose `matrix.rooms.create` decision (./guard.ts)
 * holds EVERY request for owner approval. On approve, the continuation
 * re-enters the wrapped action carrying the approval row as its grant.
 *
 * Identity: each agent speaks as its own Matrix account (Scott's choice,
 * 2026-09-19). A room is created by — and wired to — the agent that will live
 * in it, using that agent's adapter instance. Today only the default `matrix`
 * instance (@jorgenclaw) exists; a sub-agent without an account of its own is
 * refused with a clear message rather than silently speaking as someone else.
 */
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import type { MatrixRoomCapable } from '../../channels/matrix.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import {
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { getOwners } from '../permissions/db/user-roles.js';

const NAME_MAX = 80;
const TOPIC_MAX = 250;
const INVITE_MAX = 5;
/** @localpart:server (optionally :port) — the Matrix user id shape. */
const MATRIX_USER_ID = /^@[a-z0-9._=\-/+]+:[a-z0-9.-]+(:\d+)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface RoomRequest {
  name: string;
  topic: string | null;
  /** Resolved Matrix user ids to invite (defaults to the owners). */
  invite: string[];
  /** The agent group that will live in the room. */
  target: AgentGroup;
  /** Adapter registry key whose account creates and owns the room. */
  instance: string;
}

export type Resolved = { ok: true; req: RoomRequest } | { ok: false; error: string };

type RoomAdapter = { createMatrixRoom?: MatrixRoomCapable['createMatrixRoom'] };

/**
 * Which Matrix account (adapter instance) speaks for this agent. A named
 * instance `matrix-<folder>` wins; the default `matrix` instance belongs to
 * the agent that is already wired to Matrix (Jorgenclaw). Otherwise none.
 */
export function matrixInstanceFor(group: AgentGroup): string | null {
  const own = `matrix-${group.folder}`;
  if (getChannelAdapterExact(own)) return own;
  const wiredToDefault = getMessagingGroupsByAgentGroup(group.id).some(
    (mg) => mg.channel_type === 'matrix' && (mg.instance ?? 'matrix') === 'matrix',
  );
  if (wiredToDefault && getChannelAdapterExact('matrix')) return 'matrix';
  return null;
}

/** Owners' Matrix ids ("matrix:@x:y" user ids with the prefix stripped). */
function ownerMatrixIds(): string[] {
  return getOwners()
    .map((r) => r.user_id)
    .filter((id) => id.startsWith('matrix:'))
    .map((id) => id.slice('matrix:'.length));
}

/** Validate a request against the live system and resolve everything the action needs. */
export function resolveRequest(content: Record<string, unknown>, session: Session): Resolved {
  const requester = getAgentGroup(session.agent_group_id);
  if (!requester) return { ok: false, error: 'your agent group was not found.' };

  const name = typeof content.name === 'string' ? content.name.trim() : '';
  if (!name) return { ok: false, error: 'name is required.' };
  if (name.length > NAME_MAX) return { ok: false, error: `name is too long (max ${NAME_MAX} characters).` };
  if (CONTROL_CHARS.test(name)) return { ok: false, error: 'name contains control characters.' };

  let topic: string | null = null;
  if (content.topic != null && content.topic !== '') {
    if (typeof content.topic !== 'string') return { ok: false, error: 'topic must be text.' };
    topic = content.topic.trim();
    if (topic.length > TOPIC_MAX) return { ok: false, error: `topic is too long (max ${TOPIC_MAX} characters).` };
    if (CONTROL_CHARS.test(topic)) return { ok: false, error: 'topic contains control characters.' };
  }

  let invite: string[];
  if (content.invite == null) {
    invite = ownerMatrixIds();
    if (invite.length === 0) {
      return {
        ok: false,
        error: 'no owner with a Matrix identity is configured, so there is nobody to invite by default.',
      };
    }
  } else {
    if (!Array.isArray(content.invite) || !content.invite.every((v) => typeof v === 'string')) {
      return { ok: false, error: 'invite must be a list of Matrix user ids like "@scott:matrix.jorgenclaw.ai".' };
    }
    invite = [...new Set((content.invite as string[]).map((v) => v.trim()))];
    if (invite.length === 0) return { ok: false, error: 'invite is empty; leave it out to invite the owner.' };
    if (invite.length > INVITE_MAX) return { ok: false, error: `too many invitees (max ${INVITE_MAX}).` };
    const bad = invite.find((v) => !MATRIX_USER_ID.test(v));
    if (bad) return { ok: false, error: `"${bad}" is not a Matrix user id (expected "@name:server").` };
  }

  // Which agent lives in the room: the requester itself, or a sub-agent it can already address.
  let target = requester;
  const agentArg = typeof content.agent === 'string' ? content.agent.trim() : '';
  if (agentArg && normalizeName(agentArg) !== normalizeName(requester.name)) {
    const dest = getDestinationByName(requester.id, normalizeName(agentArg));
    const found = dest && dest.target_type === 'agent' ? getAgentGroup(dest.target_id) : undefined;
    if (!found) {
      return {
        ok: false,
        error: `"${agentArg}" is not one of your sub-agents. Leave "agent" out to make the room yours.`,
      };
    }
    target = found;
  }

  const instance = matrixInstanceFor(target);
  if (!instance) {
    return {
      ok: false,
      error:
        target.id === requester.id
          ? 'you are not connected to Matrix, so you cannot create rooms.'
          : `"${target.name}" has no Matrix account of its own yet, so it cannot have a room. Ask Scott to set one up first.`,
    };
  }
  const adapter = getChannelAdapterExact(instance) as RoomAdapter | undefined;
  if (!adapter?.createMatrixRoom) return { ok: false, error: 'Matrix is not connected right now. Try again later.' };

  return { ok: true, req: { name, topic, invite, target, instance } };
}

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export function validateCreateMatrixRoom(content: Record<string, unknown>, session: Session): boolean {
  const r = resolveRequest(content, session);
  if (!r.ok) {
    notifyAgent(session, `create_matrix_room failed: ${r.error}`);
    return false;
  }
  return true;
}

/** Guard hold: card the owner. The payload carries the RESOLVED invite list, so replay creates exactly what was approved. */
export async function requestCreateMatrixRoomHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const r = resolveRequest(content, session);
  if (!r.ok) return; // precheck already answered the requester
  const requester = getAgentGroup(session.agent_group_id);
  if (!requester) return;

  const { req } = r;
  await requestApproval({
    session,
    agentName: requester.name,
    action: 'create_matrix_room',
    payload: {
      name: req.name,
      topic: req.topic,
      invite: req.invite,
      agent: typeof content.agent === 'string' && content.agent.trim() ? content.agent.trim() : null,
    },
    title: `Create Matrix room: ${req.name}`,
    question:
      `Agent "${requester.name}" wants to create a private Matrix room "${req.name}"` +
      `${req.topic ? ` (${req.topic})` : ''}, invite ${req.invite.join(', ')}, ` +
      `and connect it to the agent "${req.target.name}". Approve?`,
  });
}

/** Guard allow body: creates the room, wires it to its agent, tells the requester. */
export async function createMatrixRoom(content: Record<string, unknown>, session: Session): Promise<void> {
  const r = resolveRequest(content, session);
  if (!r.ok) {
    notifyAgent(session, `create_matrix_room failed: ${r.error}`);
    return;
  }
  const { req } = r;
  const adapter = getChannelAdapterExact(req.instance) as RoomAdapter | undefined;
  if (!adapter?.createMatrixRoom) {
    notifyAgent(session, 'create_matrix_room failed: Matrix is not connected right now. Try again later.');
    return;
  }

  let created: { roomId: string; platformId: string };
  try {
    created = await adapter.createMatrixRoom({
      name: req.name,
      topic: req.topic ?? undefined,
      invite: req.invite,
      agentGroupId: req.target.id,
    });
  } catch (err) {
    log.error('create_matrix_room: homeserver refused', { name: req.name, err });
    notifyAgent(session, `create_matrix_room failed: the Matrix server refused (${(err as Error).message}).`);
    return;
  }

  const now = new Date().toISOString();
  const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mgId = `mg-${suffix()}`;
  try {
    getDb().transaction(() => {
      createMessagingGroup({
        id: mgId,
        channel_type: 'matrix',
        instance: req.instance,
        platform_id: created.platformId,
        name: req.name,
        is_group: 1,
        // Nobody unknown gets to talk to the agent through this room.
        unknown_sender_policy: 'strict',
        created_at: now,
      });
      createMessagingGroupAgent({
        id: `mga-${suffix()}`,
        messaging_group_id: mgId,
        agent_group_id: req.target.id,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      });
    })();
  } catch (err) {
    log.error('create_matrix_room: room created but wiring failed', { roomId: created.roomId, err });
    notifyAgent(
      session,
      `The room "${req.name}" was created in Matrix (${created.roomId}) but connecting it failed: ${(err as Error).message}. Tell Scott.`,
    );
    return;
  }

  // The wiring's destination row exists centrally; project it into the
  // running session so send_message(to=...) works right away.
  if (req.target.id === session.agent_group_id) writeDestinations(session.agent_group_id, session.id);

  const destination = getDestinationByTarget(req.target.id, 'channel', mgId)?.local_name;
  log.info('Matrix room created for agent', {
    roomId: created.roomId,
    messagingGroupId: mgId,
    instance: req.instance,
    agentGroupId: req.target.id,
    requestedBy: session.agent_group_id,
    invited: req.invite,
  });
  // Worded as a REPORT, not an invitation: an earlier wording ("you can post there
  // with send_message…") made the agent post into the room unprompted and then
  // answer Scott's direct-chat message inside it. Keep answering each message
  // in the conversation it came from.
  const isSelf = req.target.id === session.agent_group_id;
  notifyAgent(
    session,
    `The room "${req.name}" was created and ${req.invite.join(', ')} was invited (they must accept the invite in Element X first). ` +
      'This is only a report. Do NOT post in that room yourself, and keep answering every message in the conversation it came from. ' +
      (isSelf
        ? 'When someone writes in that room you will get their message from there, and your reply goes back to that room. '
        : `When someone writes in that room, it is handled by "${req.target.name}", not by you. `) +
      (isSelf && destination
        ? `Only if Scott asks you to post something into it, use send_message({ to: "${destination}" }).`
        : ''),
  );
}
