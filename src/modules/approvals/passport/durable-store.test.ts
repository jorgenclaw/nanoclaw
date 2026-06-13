// SqliteActionStore: the same gateway round trip + the property that justifies it existing —
// issued nonces and their consumed state survive a process restart, so a captured approval cannot
// replay against a store that forgot it. (An in-memory store would lose that on restart.)

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SqliteActionStore,
  PassportGateway,
  StandInPassport,
  DECISION,
  type ActionInput,
} from './index.js';

const passport = new StandInPassport();

function sampleAction(request_id = 'req-d1'): ActionInput {
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

describe('SqliteActionStore — round trip (in-memory db)', () => {
  it('releases on a valid, fresh, pinned-signer approval', async () => {
    const db = new Database(':memory:');
    const gw = new PassportGateway({
      pinnedPubkey: passport.pubkey,
      store: new SqliteActionStore(db),
    });
    const v = await gw.authorize(sampleAction(), (a) =>
      passport.respond({ ...a, decision: DECISION.approve }),
    );
    expect(v.release).toBe(true);
    db.close();
  });

  it('replay blocked after consume', () => {
    const db = new Database(':memory:');
    const store = new SqliteActionStore(db);
    const gw = new PassportGateway({ pinnedPubkey: passport.pubkey, store });
    const req = store.issue(sampleAction('req-d-replay'));
    const env = passport.respond({
      request_id: req.request_id,
      request_hash: store.get(req.request_id)!.expected_request_hash,
      decision: DECISION.approve,
    });
    expect(gw.verify(env).release).toBe(true);
    expect(gw.verify(env).release).toBe(false);
    db.close();
  });

  it('recompute survives params JSON round-trip (hash matches the snapshot)', () => {
    const db = new Database(':memory:');
    const store = new SqliteActionStore(db);
    const req = store.issue(sampleAction('req-d-recompute'));
    const snapshot = store.get(req.request_id)!.expected_request_hash;
    const live = store.recompute(store.get(req.request_id)!);
    expect(live.equals(snapshot)).toBe(true);
    db.close();
  });
});

describe('SqliteActionStore — survives a process restart (file db)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-store-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('an issued request verifies after reopen, and its consumed state persists (no replay)', () => {
    const file = path.join(dir, 'store.db');

    // process 1: issue, then "crash" (close).
    const db1 = new Database(file);
    const req = new SqliteActionStore(db1).issue(sampleAction('req-d-persist'));
    const reqHash = new SqliteActionStore(db1).get(req.request_id)!.expected_request_hash;
    db1.close();

    // process 2: reopen — the issued request is still there and verifies (consuming it).
    const db2 = new Database(file);
    const gw2 = new PassportGateway({
      pinnedPubkey: passport.pubkey,
      store: new SqliteActionStore(db2),
    });
    const env = passport.respond({
      request_id: req.request_id,
      request_hash: reqHash,
      decision: DECISION.approve,
    });
    expect(gw2.verify(env).release).toBe(true);
    db2.close();

    // process 3: reopen again — the consumed nonce is remembered, so the replay fails closed.
    const db3 = new Database(file);
    const gw3 = new PassportGateway({
      pinnedPubkey: passport.pubkey,
      store: new SqliteActionStore(db3),
    });
    const replay = gw3.verify(env);
    expect(replay.release).toBe(false);
    expect(replay.reason).toMatch(/issued|consumed|replay/i);
    db3.close();
  });

  it('pinned pubkey persists across reopen', () => {
    const file = path.join(dir, 'pin.db');
    const db1 = new Database(file);
    new SqliteActionStore(db1).setPinnedPubkey(passport.pubkey);
    db1.close();

    const db2 = new Database(file);
    const got = new SqliteActionStore(db2).getPinnedPubkey();
    expect(got?.equals(passport.pubkey)).toBe(true);
    db2.close();
  });
});
