// Action registry + nonce store for the gateway harness.
//
// Each high-stakes action the gateway is about to release is "issued" here: a single-use 32-byte
// nonce is minted, the canonical request_hash is snapshotted, and the row is parked in 'issued'
// state. When the signed response comes back, the verifier (verify.ts) reads this store to recompute
// the live request_hash (TOCTOU check) and to atomically consume the nonce before acting.
//
// ⚠️ PRODUCTION: this in-memory map MUST become durable (SQLite-backed) and concurrency-safe before
// it gates a real credential — a process restart that forgot issued nonces would let a captured
// approval replay, and a non-atomic consume() would allow concurrent reuse of one approval. The
// interface (NonceStore from verify.ts) is shaped so a durable impl is a drop-in. See
// groups/main/projects/keyos-authorization/gateway-enforcement-notes.md.

import { randomBytes } from "node:crypto";
import { requestHash, type AuthRequest, type Params } from "./canonical.js";
import type { NonceStore, PendingRequest } from "./verify.js";

export interface ActionInput {
  request_id: string;
  agent_id: string;
  action: string;
  risk: number;
  params: Params;
  display: string;
  /** Hard fail-safe-deny window. Default 90s. */
  ttl_ms?: number;
}

interface StoredRequest extends PendingRequest {
  /** Full request kept so recompute() can re-derive the hash from the live action. */
  request: AuthRequest;
}

export class ActionStore implements NonceStore {
  private readonly rows = new Map<string, StoredRequest>();
  private readonly clock: () => bigint;

  constructor(opts: { now_ms?: () => bigint } = {}) {
    this.clock = opts.now_ms ?? (() => BigInt(Date.now()));
  }

  now_ms(): bigint {
    return this.clock();
  }

  /** Issue a request: mint a single-use nonce, snapshot the request_hash, persist as 'issued'. */
  issue(input: ActionInput): AuthRequest {
    if (this.rows.has(input.request_id)) {
      throw new Error(`duplicate request_id: ${input.request_id}`);
    }
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
    this.rows.set(input.request_id, {
      request_id: req.request_id,
      nonce: req.nonce,
      issued_at_ms: req.issued_at_ms,
      expires_at_ms: req.expires_at_ms,
      expected_request_hash: requestHash(req),
      state: "issued",
      request: req,
    });
    return req;
  }

  // --- NonceStore impl (consumed by verify.ts) ---

  get(request_id: string): PendingRequest | undefined {
    return this.rows.get(request_id);
  }

  /** Mark consumed. In-memory + single-threaded here; a durable impl must make this atomic. */
  consume(request_id: string): void {
    const r = this.rows.get(request_id);
    if (r) r.state = "consumed";
  }

  /**
   * Recompute the request hash from the action we would execute RIGHT NOW. In this harness the live
   * action == the issued request (no drift possible in-memory). A real gateway rebuilds this from the
   * request it is actually about to send to OneCLI, so any tampering between issuance and release is
   * caught by the verifier's TOCTOU check.
   */
  recompute(p: PendingRequest): Buffer {
    const row = this.rows.get(p.request_id);
    if (!row) throw new Error("recompute: unknown request_id");
    return requestHash(row.request);
  }
}
