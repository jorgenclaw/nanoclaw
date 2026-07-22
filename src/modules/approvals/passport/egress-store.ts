// Single-use egress-token store — the bridge between Tier 1 (the WYSIWYS gate at the MCP tool) and
// Tier 2 (the fail-closed backstop at the OneCLI callback).
//
// After the gateway verifies a fresh, pinned-signer APPROVE for a typed action, that action's id
// becomes a ONE-TIME token here, bound to the exact HTTP request the credentialed call will make
// ({method, host, path, body_sha256}). The agent then stamps `X-NanoClaw-Action-Id: <id>` on its
// outbound call. When the OneCLI gateway intercepts that call and asks the host whether to release
// the credential, Tier 2 redeem()s the token: it must exist, be unspent, be unexpired, and its bound
// HTTP tuple must match the request actually being released. Anything else → deny. Single-use, so a
// captured action-id can't release a second credential.
//
// Durable (SQLite) and atomic for the same reason the nonce store is: a restart that forgot a spent
// token would let it replay, and a non-atomic spend would let two concurrent calls share one approval.
// Pass in a better-sqlite3 Database (its own file, or the central DB). Graduates to a real
// src/db/migrations/ entry when wired into the live host path.

import type Database from 'better-sqlite3';

export interface EgressBinding {
  /** HTTP method of the credentialed call this token authorizes (e.g. 'POST'). */
  method: string;
  /** Target host, matched against the gateway's ApprovalRequest.host. */
  host: string;
  /** Request path. */
  path: string;
  /** SHA-256 of the full request body, if the caller has it. Optional: the gateway only sees a
   *  truncated bodyPreview, so Tier 2 may be unable to supply this — when the token was minted WITHOUT
   *  a body hash, redeem does not check it; when it WAS minted with one, redeem requires an exact match. */
  bodySha256?: Buffer;
}

export interface MintInput extends EgressBinding {
  /** The action-id == the gateway request_id == the X-NanoClaw-Action-Id header value. */
  actionId: string;
  /** Absolute hard deadline (ms since epoch) after which the token can no longer be redeemed. */
  expiresAtMs: bigint;
}

export interface RedeemClaim {
  actionId: string;
  method: string;
  host: string;
  path: string;
  /** SHA-256 of the body of the call being released, if available to Tier 2. */
  bodySha256?: Buffer;
}

export type RedeemResult = { release: true; reason: string } | { release: false; reason: string };

interface EgressRow {
  action_id: string;
  method: string;
  host: string;
  path: string;
  body_sha256: Buffer | null;
  authorized_at_ms: string;
  expires_at_ms: string;
  state: 'authorized' | 'spent';
}

function deny(reason: string): RedeemResult {
  return { release: false, reason };
}

export class EgressTokenStore {
  private readonly db: Database.Database;
  private readonly clock: () => bigint;

  constructor(db: Database.Database, opts: { now_ms?: () => bigint } = {}) {
    this.db = db;
    this.clock = opts.now_ms ?? (() => BigInt(Date.now()));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS passport_egress (
        action_id        TEXT PRIMARY KEY,
        method           TEXT NOT NULL,
        host             TEXT NOT NULL,
        path             TEXT NOT NULL,
        body_sha256      BLOB,
        authorized_at_ms TEXT NOT NULL,
        expires_at_ms    TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT 'authorized'
      );
    `);
  }

  /**
   * Mint a single-use egress token for an already-verified action. Throws on a duplicate action-id —
   * minting is only ever called once per action, after a fresh APPROVE, so a duplicate is a bug or a
   * replay attempt and must not silently overwrite a live token.
   */
  mint(input: MintInput): void {
    if (input.bodySha256 && input.bodySha256.length !== 32) {
      throw new Error('bodySha256 must be 32 bytes');
    }
    const dup = this.db.prepare('SELECT 1 FROM passport_egress WHERE action_id = ?').get(input.actionId);
    if (dup) throw new Error(`duplicate egress action_id: ${input.actionId}`);
    this.db
      .prepare(
        `INSERT INTO passport_egress
           (action_id, method, host, path, body_sha256, authorized_at_ms, expires_at_ms, state)
         VALUES
           (@action_id, @method, @host, @path, @body_sha256, @authorized_at_ms, @expires_at_ms, 'authorized')`,
      )
      .run({
        action_id: input.actionId,
        method: input.method,
        host: input.host,
        path: input.path,
        body_sha256: input.bodySha256 ?? null,
        authorized_at_ms: this.clock().toString(),
        expires_at_ms: input.expiresAtMs.toString(),
      });
  }

  /**
   * Tier 2's decision. Atomically: the token must exist, be unspent, be unexpired, and its bound HTTP
   * tuple must match the call being released. A successful redeem CONSUMES the token (single-use). A
   * binding/body MISMATCH denies WITHOUT consuming — a wrong-tuple probe must not burn a legitimate
   * caller's token (the unguessable action-id is the cryptographic protection; an attacker who already
   * holds it could spend it directly, so refusing to burn on mismatch costs nothing and avoids a DoS on
   * the honest path). Fail-closed: any exception → deny.
   *
   * Runs inside a better-sqlite3 transaction so the read-validate-spend sequence is serialized; the
   * `AND state = 'authorized'` guard on the UPDATE is belt-and-suspenders against a concurrent spend.
   */
  redeem(claim: RedeemClaim): RedeemResult {
    try {
      const tx = this.db.transaction((c: RedeemClaim): RedeemResult => {
        const row = this.db
          .prepare(
            `SELECT action_id, method, host, path, body_sha256, authorized_at_ms, expires_at_ms, state
             FROM passport_egress WHERE action_id = ?`,
          )
          .get(c.actionId) as EgressRow | undefined;
        if (!row) return deny('unknown action-id (no verified Tier-1 authorization)');
        if (row.state !== 'authorized') return deny('egress token already spent (single-use)');
        if (this.clock() > BigInt(row.expires_at_ms)) return deny('egress token expired (fail-safe deny)');

        // Binding match — non-consuming on mismatch (see method doc).
        if (row.method !== c.method) return deny('method mismatch: signed action != released call');
        if (row.host !== c.host) return deny('host mismatch: signed action != released call');
        if (row.path !== c.path) return deny('path mismatch: signed action != released call');
        if (row.body_sha256) {
          if (!c.bodySha256 || !row.body_sha256.equals(c.bodySha256)) {
            return deny('body hash mismatch: signed action != released call');
          }
        }

        const res = this.db
          .prepare(`UPDATE passport_egress SET state = 'spent' WHERE action_id = ? AND state = 'authorized'`)
          .run(c.actionId);
        if (res.changes !== 1) return deny('lost spend race (token consumed concurrently)');
        return { release: true, reason: 'valid single-use egress token, binding matched' };
      });
      return tx(claim);
    } catch (e) {
      return deny('exception → fail-closed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** Read-only peek for audit/tests. Does NOT consume. */
  state(actionId: string): 'authorized' | 'spent' | undefined {
    const row = this.db.prepare('SELECT state FROM passport_egress WHERE action_id = ?').get(actionId) as
      | { state: 'authorized' | 'spent' }
      | undefined;
    return row?.state;
  }
}
