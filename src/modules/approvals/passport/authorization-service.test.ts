// AuthorizationService (Tier 1) + EgressTokenStore — the gate that authorizes a typed action and the
// single-use token that lets Tier 2 release exactly that one credentialed call. The properties under
// test: a verified APPROVE mints a token bound to the call; a denied/unpinned signer mints nothing; the
// token is single-use, binding-checked, expiry-checked; and all of it survives a host restart.

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthorizationService,
  EgressTokenStore,
  PassportGateway,
  SqliteActionStore,
  StandInPassport,
  autoApproveResponder,
  autoDenyResponder,
  bodySha256,
  type AuthorizeRequest,
} from './index.js';

const passport = new StandInPassport();

/** A controllable clock so expiry is testable without sleeping. */
function fixedClock(start = 1_000_000n) {
  let t = start;
  return {
    now_ms: () => t,
    advance: (ms: bigint) => {
      t += ms;
    },
  };
}

function buildService(db: Database.Database, opts: { clock?: () => bigint; pinned?: Buffer; deny?: boolean } = {}) {
  const now_ms = opts.clock;
  const gateway = new PassportGateway({
    pinnedPubkey: opts.pinned ?? passport.pubkey,
    store: new SqliteActionStore(db, now_ms ? { now_ms } : {}),
    ...(now_ms ? { now_ms } : {}),
  });
  const egress = new EgressTokenStore(db, now_ms ? { now_ms } : {});
  const responder = opts.deny ? autoDenyResponder(passport) : autoApproveResponder(passport);
  return new AuthorizationService({ gateway, egress, responder });
}

const BODY = JSON.stringify({ amount_sats: 5000, destination: 'scott@jorgenclaw.ai' });

function sampleRequest(actionId = 'act-1', overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
  return {
    actionId,
    agentId: 'jorgenclaw',
    action: 'lightning_payment',
    risk: 3,
    params: {
      amount_sats: { t: 'u64', v: 5000n },
      destination: { t: 'str', v: 'scott@jorgenclaw.ai' },
    },
    display: 'Pay 5,000 sats to scott@jorgenclaw.ai',
    egress: {
      method: 'POST',
      host: 'api.lightning.example',
      path: '/v1/pay',
      bodySha256: bodySha256(BODY),
    },
    ...overrides,
  };
}

/** The HTTP tuple Tier 2 sees when the credentialed call is intercepted. */
function matchingClaim(actionId = 'act-1') {
  return { actionId, method: 'POST', host: 'api.lightning.example', path: '/v1/pay', bodySha256: bodySha256(BODY) };
}

describe('AuthorizationService — Tier 1 → Tier 2 happy path', () => {
  it('a verified APPROVE mints a token that releases exactly the bound call', async () => {
    const db = new Database(':memory:');
    const svc = buildService(db);

    const auth = await svc.authorize(sampleRequest());
    expect(auth.authorized).toBe(true);
    expect(auth.actionId).toBe('act-1');

    const release = svc.redeem(matchingClaim());
    expect(release.release).toBe(true);
    db.close();
  });

  it('the egress token is single-use — a second release of the same action-id is denied', async () => {
    const db = new Database(':memory:');
    const svc = buildService(db);
    await svc.authorize(sampleRequest());

    expect(svc.redeem(matchingClaim()).release).toBe(true);
    const replay = svc.redeem(matchingClaim());
    expect(replay.release).toBe(false);
    expect(replay.reason).toMatch(/spent|single-use/i);
    db.close();
  });
});

describe('AuthorizationService — fail-closed: nothing to redeem unless Tier 1 approved', () => {
  it('a signed DENY mints no token, so Tier 2 denies', async () => {
    const db = new Database(':memory:');
    const svc = buildService(db, { deny: true });

    const auth = await svc.authorize(sampleRequest());
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toMatch(/denied/i);

    const release = svc.redeem(matchingClaim());
    expect(release.release).toBe(false);
    expect(release.reason).toMatch(/unknown action-id/i);
    db.close();
  });

  it('an UNPINNED signer is rejected at Tier 1 — no token minted', async () => {
    const db = new Database(':memory:');
    // Gateway pins the real device; the responder signs with a DIFFERENT (unpinned) stand-in.
    const gateway = new PassportGateway({ pinnedPubkey: passport.pubkey, store: new SqliteActionStore(db) });
    const rogue = new StandInPassport('A-DIFFERENT-UNPINNED-DEVICE');
    const svc = new AuthorizationService({
      gateway,
      egress: new EgressTokenStore(db),
      responder: autoApproveResponder(rogue),
    });

    const auth = await svc.authorize(sampleRequest());
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toMatch(/pinned/i);
    expect(svc.redeem(matchingClaim()).release).toBe(false);
    db.close();
  });

  it('a duplicate action-id fails closed (no silent overwrite of a live token)', async () => {
    const db = new Database(':memory:');
    const svc = buildService(db);
    expect((await svc.authorize(sampleRequest('dup'))).authorized).toBe(true);
    const second = await svc.authorize(sampleRequest('dup'));
    expect(second.authorized).toBe(false);
    expect(second.reason).toMatch(/duplicate/i);
    db.close();
  });
});

describe('EgressTokenStore — binding is enforced, mismatch does not burn the token', () => {
  it('denies when host/path/method differ from what was signed', async () => {
    const db = new Database(':memory:');
    const svc = buildService(db);
    await svc.authorize(sampleRequest());

    expect(svc.redeem({ ...matchingClaim(), host: 'evil.example' }).release).toBe(false);
    expect(svc.redeem({ ...matchingClaim(), path: '/v1/drain' }).release).toBe(false);
    expect(svc.redeem({ ...matchingClaim(), method: 'GET' }).release).toBe(false);

    // None of those mismatches consumed the token — the honest call still releases.
    expect(svc.redeem(matchingClaim()).release).toBe(true);
    db.close();
  });

  it('denies when the body hash differs (token was minted WITH a body hash)', async () => {
    const db = new Database(':memory:');
    const svc = buildService(db);
    await svc.authorize(sampleRequest());

    const tampered = { ...matchingClaim(), bodySha256: bodySha256('{"amount_sats":50000}') };
    expect(svc.redeem(tampered).release).toBe(false);
    // Missing body hash on the claim is also a mismatch when the token bound one.
    expect(
      svc.redeem({ actionId: 'act-1', method: 'POST', host: 'api.lightning.example', path: '/v1/pay' }).release,
    ).toBe(false);
    db.close();
  });

  it('when minted WITHOUT a body hash, redeem does not require one', async () => {
    const db = new Database(':memory:');
    const svc = buildService(db);
    await svc.authorize(
      sampleRequest('no-body', { egress: { method: 'POST', host: 'api.lightning.example', path: '/v1/pay' } }),
    );

    const release = svc.redeem({ actionId: 'no-body', method: 'POST', host: 'api.lightning.example', path: '/v1/pay' });
    expect(release.release).toBe(true);
    db.close();
  });
});

describe('EgressTokenStore — expiry', () => {
  it('valid before TTL, denied after', async () => {
    const db = new Database(':memory:');
    const clock = fixedClock();
    const svc = buildService(db, { clock: clock.now_ms });

    await svc.authorize(sampleRequest('exp2', { egressTtlMs: 5_000 }));
    clock.advance(4_000n);
    // Peek via a fresh service on the same db would share the clock; redeem here is still in-window.
    // (Use a fresh token so the in-window redeem doesn't consume the one we test after expiry.)
    await svc.authorize(sampleRequest('exp3', { egressTtlMs: 5_000 }));
    expect(svc.redeem(matchingClaim('exp3')).release).toBe(true);

    clock.advance(10_000n);
    expect(svc.redeem(matchingClaim('exp2')).release).toBe(false);
    db.close();
  });
});

describe('AuthorizationService — survives a host restart (file db)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-egress-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a token authorized in one process redeems in the next, and stays single-use across restart', async () => {
    const file = path.join(dir, 'auth.db');

    // process 1: authorize, then "crash".
    const db1 = new Database(file);
    await buildService(db1).authorize(sampleRequest('persist'));
    db1.close();

    // process 2: reopen — the token is still there and releases once.
    const db2 = new Database(file);
    const svc2 = buildService(db2);
    expect(svc2.redeem(matchingClaim('persist')).release).toBe(true);
    db2.close();

    // process 3: reopen again — the spent state persisted, so a replay fails closed.
    const db3 = new Database(file);
    const svc3 = buildService(db3);
    const replay = svc3.redeem(matchingClaim('persist'));
    expect(replay.release).toBe(false);
    expect(replay.reason).toMatch(/spent|single-use/i);
    db3.close();
  });
});
