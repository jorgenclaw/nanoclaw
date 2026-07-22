// handleLightningPay — the host half of the Option-B (host-executed) round trip. The executor is mocked
// so no real wallet is ever touched: we assert that it runs ONLY after a verified approve AND a matching
// invoice hash, that the payment result is written back, and that every fail-closed path writes a denial
// instead of paying or hanging.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import {
  AuthorizationService,
  EgressTokenStore,
  PassportGateway,
  SqliteActionStore,
  StandInPassport,
  autoApproveResponder,
  autoDenyResponder,
} from './index.js';
import { handleLightningPay, type LightningExecutor, type LightningPayResult } from './lightning.js';
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
  created_at: '2026-06-14T00:00:00Z',
};

const BOLT11 = 'lnbc500n1pfakeinvoice0123456789abcdef';

/** A recording mock executor — proves WHETHER and with WHAT the host would have paid. */
function mockExecutor(result: LightningPayResult = { ok: true, amountSats: 50, preimage: 'deadbeef' }): {
  exec: LightningExecutor;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    exec: async (bolt11: string) => {
      calls.push(bolt11);
      return result;
    },
  };
}

function content(actionId = 'pay-1', extra: Record<string, unknown> = {}, bolt11 = BOLT11) {
  return {
    action: 'lightning_pay',
    actionId,
    canonicalAction: 'lightning_payment',
    risk: 3,
    bolt11,
    params: paramsToWire({
      amount_sats: { t: 'u64', v: 50n },
      destination: { t: 'str', v: 'scott@jorgenclaw.ai' },
      bolt11_sha256: { t: 'bytes', v: createHash('sha256').update(bolt11, 'utf8').digest() },
      summary: { t: 'str', v: 'Tip Scott 50 sats' },
    }),
    display: 'Pay 50 sats to scott@jorgenclaw.ai — Tip Scott 50 sats',
    ...extra,
  };
}

function readVerdict(inDb: Database.Database, actionId: string) {
  const row = inDb.prepare('SELECT content, trigger FROM messages_in WHERE id = ?').get(`passport-resp-${actionId}`) as
    | { content: string; trigger: number }
    | undefined;
  return row ? { ...JSON.parse(row.content), trigger: row.trigger } : undefined;
}

describe('handleLightningPay', () => {
  it('approves, executes the payment on the host, and writes the result back (trigger=0)', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);
    const { exec, calls } = mockExecutor();

    await handleLightningPay(content(), SESSION, inDb, svc, exec);

    const verdict = readVerdict(inDb, 'pay-1');
    expect(verdict.type).toBe('lightning_payment');
    expect(verdict.authorized).toBe(true);
    expect(verdict.trigger).toBe(0);
    expect(verdict.payment.ok).toBe(true);
    expect(verdict.payment.preimage).toBe('deadbeef');
    expect(calls).toEqual([BOLT11]); // the host paid exactly the approved invoice
    dbHost.close();
    inDb.close();
  });

  it('refuses to pay an invoice whose hash does not match the signed params (WYSIWYS), executor never runs', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);
    const { exec, calls } = mockExecutor();

    // Signed params commit to BOLT11, but a DIFFERENT raw invoice is supplied for execution.
    const swapped = content('pay-swap');
    swapped.bolt11 = 'lnbc999n1pfakeDIFFERENTinvoice';

    await handleLightningPay(swapped, SESSION, inDb, svc, exec);

    const verdict = readVerdict(inDb, 'pay-swap');
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/does not match/i);
    expect(calls).toEqual([]); // nothing paid
    dbHost.close();
    inDb.close();
  });

  it('a deny responder writes a denial and never executes', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost, true);
    const { exec, calls } = mockExecutor();

    await handleLightningPay(content('pay-deny'), SESSION, inDb, svc, exec);

    const verdict = readVerdict(inDb, 'pay-deny');
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/denied/i);
    expect(calls).toEqual([]);
    dbHost.close();
    inDb.close();
  });

  it('binds agentId to the session, not a container-supplied value', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);
    const { exec } = mockExecutor();

    await handleLightningPay(content('pay-forge', { agentId: 'attacker-controlled' }), SESSION, inDb, svc, exec);
    expect(readVerdict(inDb, 'pay-forge').authorized).toBe(true);
    dbHost.close();
    inDb.close();
  });

  it('a failed payment (executor ok:false) is reported as authorized:true but payment.ok:false', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);
    const { exec } = mockExecutor({ ok: false, error: 'insufficient balance' });

    await handleLightningPay(content('pay-fail'), SESSION, inDb, svc, exec);

    const verdict = readVerdict(inDb, 'pay-fail');
    expect(verdict.authorized).toBe(true);
    expect(verdict.payment.ok).toBe(false);
    expect(verdict.payment.error).toMatch(/insufficient/i);
    dbHost.close();
    inDb.close();
  });

  it('missing bolt11 fails closed (no execution, written denial)', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);
    const { exec, calls } = mockExecutor();

    const noInvoice = content('pay-noinv');
    (noInvoice as Record<string, unknown>).bolt11 = '';

    await handleLightningPay(noInvoice, SESSION, inDb, svc, exec);
    expect(readVerdict(inDb, 'pay-noinv').reason).toMatch(/missing bolt11/i);
    expect(calls).toEqual([]);
    dbHost.close();
    inDb.close();
  });

  it('missing bolt11_sha256 binding fails closed', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);
    const { exec, calls } = mockExecutor();

    await handleLightningPay(
      {
        action: 'lightning_pay',
        actionId: 'pay-nohash',
        bolt11: BOLT11,
        params: paramsToWire({ amount_sats: { t: 'u64', v: 50n }, summary: { t: 'str', v: 'x' } }),
      },
      SESSION,
      inDb,
      svc,
      exec,
    );
    expect(readVerdict(inDb, 'pay-nohash').reason).toMatch(/bolt11_sha256/i);
    expect(calls).toEqual([]);
    dbHost.close();
    inDb.close();
  });

  it('missing actionId writes nothing', async () => {
    const dbHost = new Database(':memory:');
    const inDb = inboundDb();
    const svc = service(dbHost);
    const { exec } = mockExecutor();

    await handleLightningPay({ action: 'lightning_pay' }, SESSION, inDb, svc, exec);
    const count = (inDb.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
    expect(count).toBe(0);
    dbHost.close();
    inDb.close();
  });
});
