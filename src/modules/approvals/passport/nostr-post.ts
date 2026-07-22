// Option B (host-executed) Tier-1 gate — Nostr/Clawstr posts.
//
// Nostr signing uses a Unix socket to the signing daemon — there is no outbound HTTPS call for
// OneCLI to intercept. The only unbypassable gate is host-execution: the container's nostr_post
// tool writes a system message and blocks; this handler runs the Passport gate and, only on a
// verified APPROVE, publishes via clawstr-post using the host-held signer socket.
//
// Phase 1 (advisory): the clawstr-post mount is still in the container (nostr-dm channel config),
// so a direct bash call can still bypass this. Phase 2 removes that mount.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../../delivery.js';
import { insertMessage } from '../../../db/session-db.js';
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';
import type { AuthorizationService } from './authorization-service.js';
import { getAuthorizationService } from './service-host.js';
import { RISK } from './canonical.js';
import { paramsFromWire, type ParamsWire } from './wire.js';

const execFileAsync = promisify(execFile);

export const NOSTR_POST_ACTION = 'nostr_post';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/modules/approvals/passport/nostr-post.js → project root four levels up.
const projectRoot = path.resolve(__dirname, '../../../..');
const CLAWSTR_POST_SCRIPT = path.join(projectRoot, 'tools/nostr-signer/clawstr-post.js');

export interface NostrPostResult {
  ok: boolean;
  eventId?: string;
  error?: string;
}

export type NostrPostExecutor = (subclaw: string, body: string) => Promise<NostrPostResult>;

function writeVerdict(
  inDb: Database.Database,
  actionId: string,
  authorized: boolean,
  reason: string,
  post?: NostrPostResult,
): void {
  insertMessage(inDb, {
    id: `passport-resp-${actionId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({
      type: 'nostr_post',
      actionId,
      authorized,
      reason,
      ...(post ?? {}),
    }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

/**
 * Pure handler (service + executor injected) so it is unit-testable without the singleton or a
 * real signing daemon. Fail-closed: any parse/auth/runtime failure writes authorized:false.
 */
export async function handleNostrPost(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  service: AuthorizationService,
  executor: NostrPostExecutor,
): Promise<void> {
  const actionId = content.actionId as string;
  if (!actionId) {
    log.warn('nostr_post missing actionId — cannot respond', { sessionId: session.id });
    return;
  }

  try {
    const params = paramsFromWire((content.params as ParamsWire) ?? {});
    const subclaw = params.subclaw?.t === 'str' ? params.subclaw.v : '';
    const body = params.body?.t === 'str' ? params.body.v : '';

    if (!subclaw || !body) {
      writeVerdict(inDb, actionId, false, 'missing subclaw or body');
      return;
    }

    const result = await service.authorizeLocal({
      actionId,
      agentId: session.agent_group_id,
      action: String(content.canonicalAction ?? 'nostr_post'),
      risk: Number(content.risk ?? RISK.critical),
      params,
      display: String(content.display ?? `Post to /${subclaw}`),
    });

    if (!result.authorized) {
      writeVerdict(inDb, actionId, false, result.reason);
      log.info('nostr_post denied', { sessionId: session.id, actionId, reason: result.reason });
      return;
    }

    const post = await executor(subclaw, body);
    writeVerdict(inDb, actionId, true, result.reason, post);
    log.info('nostr_post handled', { sessionId: session.id, actionId, ok: post.ok });
  } catch (e) {
    writeVerdict(inDb, actionId, false, 'host exception → fail-closed');
    log.error('nostr_post errored', { sessionId: session.id, actionId, err: e });
  }
}

/**
 * Default executor: run clawstr-post on the host using the host-side signer socket.
 * The container path (/run/nostr/signer.sock) is NOT used — the host daemon socket is at
 * $XDG_RUNTIME_DIR/nostr-signer.sock. process.execPath avoids PATH issues under systemd --user.
 */
export function clawstrPostExecutor(): NostrPostExecutor {
  return async (subclaw: string, body: string): Promise<NostrPostResult> => {
    const signerSocket = process.env.XDG_RUNTIME_DIR
      ? `${process.env.XDG_RUNTIME_DIR}/nostr-signer.sock`
      : '/run/user/1000/nostr-signer.sock';
    try {
      const { stdout } = await execFileAsync(process.execPath, [CLAWSTR_POST_SCRIPT, 'post', subclaw, body], {
        env: { ...process.env, NOSTR_SIGNER_SOCKET: signerSocket },
        timeout: 30_000,
      });
      const trimmed = stdout.trim();
      const eventId = trimmed.match(/[0-9a-f]{64}/)?.[0];
      return { ok: true, eventId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };
}

registerDeliveryAction(NOSTR_POST_ACTION, (content, session, inDb) =>
  handleNostrPost(content, session, inDb, getAuthorizationService(), clawstrPostExecutor()),
);
