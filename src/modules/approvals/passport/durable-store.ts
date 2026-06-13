// Durable (SQLite-backed) action registry + nonce store — the production-grade twin of the in-memory
// ActionStore. This is the version that may gate a real credential: it survives a host restart (so a
// captured approval can't replay against a store that "forgot" the consumed nonce) and makes consume()
// atomic at the SQLite statement level (so two concurrent verifies can't both spend one approval).
//
// Same NonceStore interface as verify.ts → drop-in for ActionStore. Tables are created idempotently on
// construction; when this is wired into the live host it should graduate to a proper migration under
// src/db/migrations/. Pass in a better-sqlite3 Database (its own file, or the central DB).

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { requestHash, type AuthRequest, type Params, type ParamValue } from './canonical.js';
import type { NonceStore, PendingRequest } from './verify.js';
import type { ActionInput } from './store.js';

// Params serialized as JSON for storage. u64 -> decimal string (BigInt-safe), bytes -> hex. Key order
// is irrelevant: encodeMap() sorts keys, so the recomputed hash is identical regardless of JSON order.
type ParamJSON = { t: ParamValue['t']; v: string | boolean };

function paramsToJSON(p: Params): string {
  const o: Record<string, ParamJSON> = {};
  for (const [k, val] of Object.entries(p)) {
    switch (val.t) {
      case 'u64':
        o[k] = { t: 'u64', v: val.v.toString() };
        break;
      case 'str':
        o[k] = { t: 'str', v: val.v };
        break;
      case 'bool':
        o[k] = { t: 'bool', v: val.v };
        break;
      case 'bytes':
        o[k] = { t: 'bytes', v: val.v.toString('hex') };
        break;
    }
  }
  return JSON.stringify(o);
}

function paramsFromJSON(s: string): Params {
  const o = JSON.parse(s) as Record<string, ParamJSON>;
  const out: Params = {};
  for (const [k, val] of Object.entries(o)) {
    switch (val.t) {
      case 'u64':
        out[k] = { t: 'u64', v: BigInt(val.v as string) };
        break;
      case 'str':
        out[k] = { t: 'str', v: val.v as string };
        break;
      case 'bool':
        out[k] = { t: 'bool', v: val.v as boolean };
        break;
      case 'bytes':
        out[k] = { t: 'bytes', v: Buffer.from(val.v as string, 'hex') };
        break;
      default:
        throw new Error(`unknown param type ${(val as ParamJSON).t}`);
    }
  }
  return out;
}

interface PendingRow {
  request_id: string;
  agent_id: string;
  action: string;
  risk: number;
  issued_at_ms: string;
  expires_at_ms: string;
  nonce: Buffer;
  params_json: string;
  display: string;
  expected_request_hash: Buffer;
  state: 'issued' | 'consumed';
}

export class SqliteActionStore implements NonceStore {
  private readonly db: Database.Database;
  private readonly clock: () => bigint;

  constructor(db: Database.Database, opts: { now_ms?: () => bigint } = {}) {
    this.db = db;
    this.clock = opts.now_ms ?? (() => BigInt(Date.now()));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS passport_pending (
        request_id            TEXT PRIMARY KEY,
        agent_id              TEXT NOT NULL,
        action                TEXT NOT NULL,
        risk                  INTEGER NOT NULL,
        issued_at_ms          TEXT NOT NULL,
        expires_at_ms         TEXT NOT NULL,
        nonce                 BLOB NOT NULL,
        params_json           TEXT NOT NULL,
        display               TEXT NOT NULL,
        expected_request_hash BLOB NOT NULL,
        state                 TEXT NOT NULL DEFAULT 'issued'
      );
      CREATE TABLE IF NOT EXISTS passport_pin (
        id     INTEGER PRIMARY KEY CHECK (id = 1),
        pubkey BLOB NOT NULL
      );
    `);
  }

  now_ms(): bigint {
    return this.clock();
  }

  /** Issue a request: mint a single-use nonce, snapshot the request_hash, persist as 'issued'. */
  issue(input: ActionInput): AuthRequest {
    const dup = this.db.prepare('SELECT 1 FROM passport_pending WHERE request_id = ?').get(input.request_id);
    if (dup) throw new Error(`duplicate request_id: ${input.request_id}`);
    const issued = this.clock();
    const ttl = BigInt(input.ttl_ms ?? 90_000);
    const req: AuthRequest = {
      request_id: input.request_id,
      agent_id: input.agent_id,
      action: input.action,
      risk: input.risk,
      issued_at_ms: issued,
      expires_at_ms: issued + ttl,
      nonce: randomBytes(32),
      params: input.params,
      display: input.display,
    };
    this.db
      .prepare(
        `INSERT INTO passport_pending
           (request_id, agent_id, action, risk, issued_at_ms, expires_at_ms, nonce, params_json, display, expected_request_hash, state)
         VALUES
           (@request_id, @agent_id, @action, @risk, @issued_at_ms, @expires_at_ms, @nonce, @params_json, @display, @expected_request_hash, 'issued')`,
      )
      .run({
        request_id: req.request_id,
        agent_id: req.agent_id,
        action: req.action,
        risk: req.risk,
        issued_at_ms: req.issued_at_ms.toString(),
        expires_at_ms: req.expires_at_ms.toString(),
        nonce: req.nonce,
        params_json: paramsToJSON(req.params),
        display: req.display,
        expected_request_hash: requestHash(req),
      });
    return req;
  }

  // --- NonceStore impl (consumed by verify.ts) ---

  get(request_id: string): PendingRequest | undefined {
    const row = this.db
      .prepare(
        `SELECT request_id, nonce, issued_at_ms, expires_at_ms, expected_request_hash, state
         FROM passport_pending WHERE request_id = ?`,
      )
      .get(request_id) as Pick<
      PendingRow,
      'request_id' | 'nonce' | 'issued_at_ms' | 'expires_at_ms' | 'expected_request_hash' | 'state'
    > | undefined;
    if (!row) return undefined;
    return {
      request_id: row.request_id,
      nonce: row.nonce,
      issued_at_ms: BigInt(row.issued_at_ms),
      expires_at_ms: BigInt(row.expires_at_ms),
      expected_request_hash: row.expected_request_hash,
      state: row.state,
    };
  }

  /**
   * Atomically mark consumed. The `AND state = 'issued'` guard makes a double-consume a no-op, so two
   * concurrent verifies cannot both spend one approval — the durable analogue of the in-memory race note.
   */
  consume(request_id: string): void {
    this.db
      .prepare(`UPDATE passport_pending SET state = 'consumed' WHERE request_id = ? AND state = 'issued'`)
      .run(request_id);
  }

  /** Recompute the request hash from the persisted action (the live action == issued request here). */
  recompute(p: PendingRequest): Buffer {
    const row = this.db
      .prepare(
        `SELECT request_id, agent_id, action, risk, issued_at_ms, expires_at_ms, nonce, params_json, display
         FROM passport_pending WHERE request_id = ?`,
      )
      .get(p.request_id) as PendingRow | undefined;
    if (!row) throw new Error('recompute: unknown request_id');
    return requestHash({
      request_id: row.request_id,
      agent_id: row.agent_id,
      action: row.action,
      risk: row.risk,
      issued_at_ms: BigInt(row.issued_at_ms),
      expires_at_ms: BigInt(row.expires_at_ms),
      nonce: row.nonce,
      params: paramsFromJSON(row.params_json),
      display: row.display,
    });
  }

  // --- TOFU pinned device key (established once at pairing) ---

  /** Pin the device pubkey. Re-pinning must be human-gated at the caller (PROTOCOL.md §5.1). */
  setPinnedPubkey(pubkey: Buffer): void {
    if (pubkey.length !== 33) throw new Error('pinned pubkey must be 33 bytes (compressed)');
    this.db
      .prepare(`INSERT INTO passport_pin (id, pubkey) VALUES (1, @pubkey) ON CONFLICT(id) DO UPDATE SET pubkey = excluded.pubkey`)
      .run({ pubkey });
  }

  getPinnedPubkey(): Buffer | undefined {
    const row = this.db.prepare(`SELECT pubkey FROM passport_pin WHERE id = 1`).get() as
      | { pubkey: Buffer }
      | undefined;
    return row?.pubkey;
  }
}
