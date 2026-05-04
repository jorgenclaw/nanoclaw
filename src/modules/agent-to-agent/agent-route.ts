/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied verbatim;
 * the target's formatter looks up the source agent in its own local map to
 * display a name.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
  /** Populated when this is a reply from an agent that received an A2A message. */
  origin_session_id?: string | null;
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }

  // If the outbound message has an origin_session_id, this is a reply back to
  // the session that initiated the A2A conversation. Deliver there directly
  // instead of using findSessionByAgentGroup, which may pick the wrong session
  // when multiple active sessions exist for the same agent group.
  let targetSession: Session;
  if (msg.origin_session_id) {
    const originSession = getSession(msg.origin_session_id);
    if (originSession && originSession.agent_group_id === targetAgentGroupId && originSession.status === 'active') {
      targetSession = originSession;
      log.info('Agent reply threaded to origin session', {
        from: session.agent_group_id,
        to: targetAgentGroupId,
        originSession: originSession.id,
      });
    } else {
      // Origin session is stale or archived — fall back to best-available session.
      log.warn('Origin session unavailable, falling back to findSessionByAgentGroup', {
        originSessionId: msg.origin_session_id,
        targetAgentGroupId,
      });
      const { session: resolved } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
      targetSession = resolved;
    }
  } else {
    const { session: resolved } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
    targetSession = resolved;
  }

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: msg.content,
    originSessionId: session.id,
  });
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}
