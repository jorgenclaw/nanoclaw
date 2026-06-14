// Tier-1 delivery action — the host half of the container↔host authorize round trip (Option A).
//
// A high-stakes MCP tool in the container writes a `kind:'system'` outbound message with
// action='passport_authorize', then BLOCKS polling inbound.db for the verdict (the ask_user_question
// pattern). The delivery poll routes that message here. We run the gate (issue → Passport signs →
// verify → mint single-use egress token) and write the verdict back into inbound.db as
// `passport-resp-<actionId>` (trigger=0, so it resolves the tool's poll without waking the agent).
//
// Mirrors the cli_request/cli_response handler (src/cli/delivery-action.ts). Authorizing does NOT
// release any credential — it signs/verifies and mints a token the agent can later present. Tier 2 (the
// OneCLI callback) is what would consume that token to release a real credential, and is deliberately
// not wired here.

import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../../delivery.js';
import { insertMessage } from '../../../db/session-db.js';
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';
import type { AuthorizationService } from './authorization-service.js';
import { getAuthorizationService } from './service-host.js';
import { paramsFromWire, type ParamsWire } from './wire.js';
import type { EgressBinding } from './egress-store.js';
import type { Params } from './canonical.js';

export const PASSPORT_AUTHORIZE_ACTION = 'passport_authorize';

/**
 * Derive the egress binding from the SIGNED params, not a separate field. The frozen canonical contract
 * can't grow fields, so an Option-A HTTP action carries its wire identity as params: `method`/`host`/
 * `path` (str), plus `body_sha256` (bytes) for the body. Because these live in `params`, they are inside
 * the request_hash the Passport signs. No method/host/path → not a valid Option-A request → caller denies.
 *
 * The token binds method+host+path ONLY — deliberately NOT the body. The OneCLI gateway hands Tier 2 a
 * *truncated* bodyPreview, so Tier 2 cannot reliably recompute a full-body hash; a body-bound token would
 * be unredeemable for any non-trivial body. The body's integrity instead rides on the Passport signature
 * over params.body_sha256 (Tier 1). Body-bound tokens stay available for host-executed actions (Option B)
 * where the host sees the full bytes — that's why EgressTokenStore still supports bodySha256.
 */
function egressFromParams(params: Params): EgressBinding | null {
  const method = params.method?.t === 'str' ? params.method.v : undefined;
  const host = params.host?.t === 'str' ? params.host.v : undefined;
  const path = params.path?.t === 'str' ? params.path.v : undefined;
  if (!method || !host || !path) return null;
  return { method, host, path };
}

/** Write the verdict into inbound.db so the blocked tool poll resolves. trigger=0: don't wake the agent. */
function writeVerdict(inDb: Database.Database, actionId: string, authorized: boolean, reason: string): void {
  insertMessage(inDb, {
    id: `passport-resp-${actionId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'passport_authorization', actionId, authorized, reason }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

/**
 * Pure handler (service injected) so it is unit-testable without the singleton. Fail-closed: any parse
 * or runtime error writes an `authorized:false` verdict rather than leaving the tool to hang to timeout.
 */
export async function handlePassportAuthorize(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  service: AuthorizationService,
): Promise<void> {
  const actionId = content.actionId as string;
  if (!actionId) {
    log.warn('passport_authorize missing actionId — cannot respond', { sessionId: session.id });
    return;
  }

  try {
    const params = paramsFromWire((content.params as ParamsWire) ?? {});
    const egress = egressFromParams(params);
    if (!egress) {
      writeVerdict(inDb, actionId, false, 'params missing method/host/path egress binding');
      return;
    }

    const result = await service.authorize({
      actionId,
      // Bind to the REAL originating agent group, not a container-supplied value the agent could forge.
      agentId: session.agent_group_id,
      action: String(content.canonicalAction ?? ''),
      risk: Number(content.risk ?? 0),
      params,
      display: String(content.display ?? ''),
      egress,
      ...(typeof content.ttlMs === 'number' ? { ttlMs: content.ttlMs } : {}),
      ...(typeof content.egressTtlMs === 'number' ? { egressTtlMs: content.egressTtlMs } : {}),
    });

    writeVerdict(inDb, actionId, result.authorized, result.reason);
    log.info('passport_authorize handled', {
      sessionId: session.id,
      actionId,
      authorized: result.authorized,
      reason: result.reason,
    });
  } catch (err) {
    writeVerdict(inDb, actionId, false, 'host exception → fail-closed');
    log.error('passport_authorize errored', { sessionId: session.id, actionId, err });
  }
}

registerDeliveryAction(PASSPORT_AUTHORIZE_ACTION, (content, session, inDb) =>
  handlePassportAuthorize(content, session, inDb, getAuthorizationService()),
);
