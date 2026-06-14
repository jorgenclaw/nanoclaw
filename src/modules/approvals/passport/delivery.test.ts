// handlePassportAuthorize — the host half of the Option-A round trip. Feed it a container-style content
// object + a real inbound.db + a fake session; assert it writes the right verdict row back, that the
// minted egress token redeems, and that fail-closed cases (deny responder, malformed egress) write a
// denial instead of hanging.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import {
  AuthorizationService,
  EgressTokenStore,
  PassportGateway,
  SqliteActionStore,
  StandInPassport,
  autoApproveResponder,
  autoDenyResponder,
  bodySha256,
} from './index.js';
import { handlePassportAuthorize } from './delivery.js';
import { paramsToWire } from './wire.js';
import type { Session } from '../../../types.js';

const passport = new StandInPassport();

function inboundDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(INBOUND_SCHEMA);
  return db;
}

function service(db: Database.Database, deny = false): AuthorizationService {
  const gateway = new PassportGateway({ pinnedPubkey: passport.pubkey, store: new SqliteActionStore(db) });
  const egress = new EgressTokenStore(db);
  const responder = deny ? autoDenyResponder(passport) : autoApproveResponder(passport);
  return new AuthorizationService({ gateway, egress, responder });
}

const SESSION: Session = {
  id: 'sess-1',
  agent_group_id: 'main',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-06-13T00:00:00Z',
};

const BODY = JSON.stringify({ amount_sats: 5000, destination: 'scott@jorgenclaw.ai' });

// Option-A convention: the wire identity (method/host/path/body_sha256) lives INSIDE params, so the
// Passport's signature covers it and the host derives the egress binding from signed data.
function content(actionId = 'act-1', extra: Record<string, unknown> = {}) {
  return {
    action: 'passport_authorize',
    actionId,
    canonicalAction: 'github_write',
    risk: 3,
    params: paramsToWire({
      method: { t: 'str', v: 'POST' },
      host: { t: 'str', v: 'api.github.com' },
      path: { t: 'str', v: '/repos/jorgenclaw/test/issues' },
      body_sha256: { t: 'bytes', v: bodySha256(BODY) },
      summary: { t: 'str', v: 'Create issue "hello"' },
    }),
    display: 'GitHub POST /repos/jorgenclaw/test/issues — create issue "hello"',
    ...extra,
  };
}

function readVerdict(inDb: Database.Database, actionId: string) {
  const row = inDb.prepare('SELECT content, trigger FROM messages_in WHERE id = ?').get(`passport-resp-${actionId}`) as
    | { content: string; trigger: number }
    | undefined;
  return row ? { ...JSON.parse(row.content), trigger: row.trigger } : undefined;
}

describe('handlePassportAuthorize', () => {
  it('approves a valid request, writes an authorized verdict (trigger=0), and the token redeems', async () => {
    const dbHost = new Database(':memory:'); // gate storage
    const inDb = inboundDb(); // session inbound
    const svc = service(dbHost);

    await handlePassportAuthorize(content(), SESSION, inDb, svc);

    const verdict = readVerdict(inDb, 'act-1');
    expect(verdict).toBeTruthy();
    expect(verdict.type).toBe('passport_authorization');
    expect(verdict.authorized).toBe(true);
    expect(verdict.trigger).toBe(0); // inline response, must not wake the agent

    // A call to a DIFFERENT endpoint with the token is denied (binding holds) — and a mismatch is
    // non-consuming, so the honest call below still releases.
    const wrong = svc.redeem({
      actionId: 'act-1',
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/evil/x/issues',
    });
    expect(wrong.release).toBe(false);

    // The minted egress token releases on method+host+path alone — the real Tier-2 gateway only sees a
    // truncated bodyPreview and can't supply a full-body hash, so the token must not require one.
    const release = svc.redeem({
      actionId: 'act-1',
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/jorgenclaw/test/issues',
    });
    expect(release.release).toBe(true);
    dbHost.close();
    inDb.close();
  });

  it('binds agentId to the session, not a container-supplied value', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);

    // A forged agentId in the message must be ignored; authorization still succeeds bound to the session.
    await handlePassportAuthorize(content('act-forge', { agentId: 'attacker-controlled' }), SESSION, inDb, svc);
    expect(readVerdict(inDb, 'act-forge').authorized).toBe(true);
    dbHost.close();
    inDb.close();
  });

  it('a deny responder writes an authorized:false verdict and mints no token', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost, true);

    await handlePassportAuthorize(content('act-deny'), SESSION, inDb, svc);

    const verdict = readVerdict(inDb, 'act-deny');
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/denied/i);
    expect(
      svc.redeem({
        actionId: 'act-deny',
        method: 'POST',
        host: 'api.github.com',
        path: '/repos/jorgenclaw/test/issues',
      }).release,
    ).toBe(false);
    dbHost.close();
    inDb.close();
  });

  it('params missing the wire binding fails closed with a written denial (does not hang)', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);

    // params without method/host/path — not a valid Option-A request.
    await handlePassportAuthorize(
      { action: 'passport_authorize', actionId: 'act-bad', params: paramsToWire({ summary: { t: 'str', v: 'x' } }) },
      SESSION,
      inDb,
      svc,
    );

    const verdict = readVerdict(inDb, 'act-bad');
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/missing method\/host\/path/i);
    dbHost.close();
    inDb.close();
  });

  it('missing actionId writes nothing (cannot key a response)', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);

    await handlePassportAuthorize({ action: 'passport_authorize' }, SESSION, inDb, svc);
    const count = (inDb.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
    expect(count).toBe(0);
    dbHost.close();
    inDb.close();
  });
});
