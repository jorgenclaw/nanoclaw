// Offline gateway round trip + attack matrix, exercised through the StandInPassport.
// Every non-(valid, fresh, pinned, approve) path must fail closed (release:false).

import { describe, it, expect } from 'vitest';
import {
  PassportGateway,
  StandInPassport,
  ActionStore,
  verifyAuthorization,
  DECISION,
  type ActionInput,
} from './index.js';

const passport = new StandInPassport(); // the pinned device for all tests

function sampleAction(request_id = 'req-rt-1'): ActionInput {
  return {
    request_id,
    agent_id: 'jorgenclaw',
    action: 'lightning_payment',
    risk: 3,
    params: {
      amount_sats: { t: 'u64', v: 5000n },
      destination: { t: 'str', v: 'scott@jorgenclaw.ai' },
    },
    display: 'Pay 5,000 sats to scott@jorgenclaw.ai',
  };
}

describe('PassportGateway — happy path', () => {
  it('releases on a valid, fresh, pinned-signer approval', async () => {
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey });
    const v = await gw.authorize(sampleAction(), (a) => passport.respond({ ...a, decision: DECISION.approve }));
    expect(v).toEqual({
      release: true,
      decision: 'approve',
      reason: 'valid, fresh, pinned-signer approval',
    });
  });

  it('does NOT release on a signed denial', async () => {
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey });
    const v = await gw.authorize(sampleAction('req-deny'), (a) => passport.respond({ ...a, decision: DECISION.deny }));
    expect(v.release).toBe(false);
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/denied/i);
  });
});

describe('PassportGateway — attack matrix (all fail closed)', () => {
  it('replay: a consumed approval cannot be reused', () => {
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey });
    const req = gw.store.issue(sampleAction('req-replay'));
    const env = passport.respond({
      request_id: req.request_id,
      request_hash: gw.store.get(req.request_id)!.expected_request_hash,
      decision: DECISION.approve,
    });
    expect(gw.verify(env).release).toBe(true); // first use consumes the nonce
    const second = gw.verify(env);
    expect(second.release).toBe(false);
    expect(second.reason).toMatch(/issued|consumed|replay/i);
  });

  it('expired: past the hard deadline → deny', () => {
    let now = 1_000_000n;
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey, now_ms: () => now });
    const req = gw.store.issue({ ...sampleAction('req-exp'), ttl_ms: 1000 });
    const env = passport.respond({
      request_id: req.request_id,
      request_hash: gw.store.get(req.request_id)!.expected_request_hash,
      decision: DECISION.approve,
    });
    now = 1_002_000n; // past expires_at (issued + 1000)
    const v = gw.verify(env);
    expect(v.release).toBe(false);
    expect(v.reason).toMatch(/expired/i);
  });

  it('unpinned signer: a different device is rejected', async () => {
    const other = new StandInPassport('a-different-device');
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey });
    const v = await gw.authorize(sampleAction('req-unpinned'), (a) =>
      other.respond({ ...a, decision: DECISION.approve }),
    );
    expect(v.release).toBe(false);
    expect(v.reason).toMatch(/pinned/i);
  });

  it('WYSIWYS mismatch: signing a different request_hash than was issued', () => {
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey });
    const req = gw.store.issue(sampleAction('req-wysiwys'));
    const bogus = Buffer.alloc(32, 0xab);
    const env = passport.respond({
      request_id: req.request_id,
      request_hash: bogus, // device signs over an action that isn't the one we'll execute
      decision: DECISION.approve,
    });
    const v = gw.verify(env);
    expect(v.release).toBe(false);
    expect(v.reason).toMatch(/WYSIWYS|signed action/i);
  });

  it('tampered signature: a flipped byte fails verification', () => {
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey });
    const req = gw.store.issue(sampleAction('req-sig'));
    const env = passport.respond({
      request_id: req.request_id,
      request_hash: gw.store.get(req.request_id)!.expected_request_hash,
      decision: DECISION.approve,
    });
    env.signature[0] ^= 0xff;
    const v = gw.verify(env);
    expect(v.release).toBe(false);
    expect(v.reason).toMatch(/signature/i);
  });

  it('unknown request_id: nothing was issued for it', () => {
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey });
    const env = passport.respond({
      request_id: 'never-issued',
      request_hash: Buffer.alloc(32, 0x07),
      decision: DECISION.approve,
    });
    const v = gw.verify(env);
    expect(v.release).toBe(false);
    expect(v.reason).toMatch(/unknown request_id/i);
  });

  it('TOCTOU: live action drifted from the issuance snapshot → block', () => {
    // Drive the verifier directly with a recompute that returns a different hash, simulating the
    // executable action changing between issuance and release.
    const store = new ActionStore();
    const req = store.issue(sampleAction('req-toctou'));
    const env = passport.respond({
      request_id: req.request_id,
      request_hash: store.get(req.request_id)!.expected_request_hash,
      decision: DECISION.approve,
    });
    const v = verifyAuthorization(env, {
      store,
      now_ms: () => BigInt(Date.now()),
      pinnedPubkey: passport.pubkey,
      recomputeRequestHash: () => Buffer.alloc(32, 0x01), // pretend the live action drifted
    });
    expect(v.release).toBe(false);
    expect(v.reason).toMatch(/drift|TOCTOU/i);
  });
});
