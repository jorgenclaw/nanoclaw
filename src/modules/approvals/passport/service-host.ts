// Host-side singleton wiring of the Tier-1 AuthorizationService onto durable storage.
//
// One process-wide service backed by data/passport.db. The nonce store and the egress-token store share
// that single file so the signing handshake and the Tier-2 redeem record stay consistent across a
// restart. The pinned device key is TOFU: on first run, with nothing pinned, we pin the stand-in's
// pubkey (pairing). Thereafter the pin is required — an unpinned signer fails closed.
//
// ⚠️ STAND-IN PHASE. The responder here is the SOFTWARE StandInPassport via autoApproveResponder — it
// AUTO-APPROVES. That is NOT a human approval and makes NO security claim; it is the offline placeholder
// for the real device, exactly as the in-app software signer stands in for os/security. The real
// approval surface is the Passport Prime trusted screen (never a phone/chat card). When the device lands
// over os/mcp, swap the responder for the real transport AND re-establish the pin under a human-gated
// pairing (PROTOCOL.md §5.1) — re-pinning must never be automatic. Until then, nothing here gates a real
// credential on its own (Tier 2 is not wired into the live OneCLI path).

import Database from 'better-sqlite3';
import path from 'node:path';

import { DATA_DIR } from '../../../config.js';
import { log } from '../../../log.js';
import {
  AuthorizationService,
  EgressTokenStore,
  PassportGateway,
  SqliteActionStore,
  StandInPassport,
  autoApproveResponder,
} from './index.js';

let service: AuthorizationService | null = null;
let handle: Database.Database | null = null;

/** Lazily build (or return) the process-wide Tier-1 service. */
export function getAuthorizationService(): AuthorizationService {
  if (service) return service;

  const file = path.join(DATA_DIR, 'passport.db');
  handle = new Database(file);
  const store = new SqliteActionStore(handle);
  const egress = new EgressTokenStore(handle);

  // TOFU pairing for the stand-in: pin its key once, then require it.
  const standIn = new StandInPassport();
  let pinned = store.getPinnedPubkey();
  if (!pinned) {
    store.setPinnedPubkey(standIn.pubkey);
    pinned = standIn.pubkey;
    log.warn('[passport] TOFU-pinned the STAND-IN signer key (software placeholder, not a real device)', {
      db: file,
      pubkey: standIn.pubkey.toString('hex'),
    });
  }

  const gateway = new PassportGateway({ pinnedPubkey: pinned, store });
  service = new AuthorizationService({ gateway, egress, responder: autoApproveResponder(standIn) });
  log.info('[passport] Tier-1 authorization service ready', { db: file });
  return service;
}

/** Test-only: inject a service (e.g. one with a deny responder / in-memory db) and reset between tests. */
export function __setAuthorizationServiceForTest(svc: AuthorizationService | null): void {
  service = svc;
  if (!svc && handle) {
    handle.close();
    handle = null;
  }
}
