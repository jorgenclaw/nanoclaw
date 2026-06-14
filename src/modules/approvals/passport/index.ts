// Passport gateway harness — the host-side glue that ties issue → (Passport signs) → verify into one
// fail-closed flow. The "responder" is the Passport: a software StandInPassport today, the real
// device over os/mcp later. There is exactly one release:true outcome, inherited from the vendored
// verifier (verify.ts) — this class adds no new release path.

import {
  verifyAuthorization,
  type Verdict,
  type VerifyDeps,
  type ResponseEnvelope,
  type PendingRequest,
  type NonceStore,
} from './verify.js';
import { ActionStore, type ActionInput } from './store.js';
import type { AuthRequest } from './canonical.js';

export { ActionStore } from './store.js';
export type { ActionInput } from './store.js';
export { SqliteActionStore } from './durable-store.js';
export { StandInPassport } from './signer.js';
export type { SignArgs } from './signer.js';
export { verifyAuthorization } from './verify.js';
export type { Verdict, ResponseEnvelope, PendingRequest, NonceStore, VerifyDeps } from './verify.js';
export { EgressTokenStore } from './egress-store.js';
export type { EgressBinding, MintInput, RedeemClaim, RedeemResult } from './egress-store.js';
export { AuthorizationService, autoApproveResponder, autoDenyResponder, bodySha256 } from './authorization-service.js';
export type {
  AuthorizeRequest,
  AuthorizeLocalRequest,
  AuthorizeResult,
  AuthorizationServiceOptions,
} from './authorization-service.js';
export * from './canonical.js';

/** Anything that turns an issued request into a signed envelope (the Passport, stand-in or real). */
export type Responder = (args: {
  request_id: string;
  request_hash: Buffer;
}) => ResponseEnvelope | Promise<ResponseEnvelope>;

/**
 * What the gateway needs from a store, structurally — satisfied by both ActionStore (in-memory) and
 * SqliteActionStore (durable). An interface (not the concrete class) so either is assignable; the
 * concrete classes carry private fields that would otherwise make them nominally incompatible.
 */
export interface PassportStore extends NonceStore {
  issue(input: ActionInput): AuthRequest;
  recompute(p: PendingRequest): Buffer;
  now_ms(): bigint;
}

export interface GatewayOptions {
  /** TOFU-pinned 33-byte compressed device pubkey, established once at pairing. */
  pinnedPubkey: Buffer;
  now_ms?: () => bigint;
  store?: PassportStore;
}

export class PassportGateway {
  readonly store: PassportStore;
  private readonly pinned: Buffer;
  private readonly clock: () => bigint;

  constructor(opts: GatewayOptions) {
    this.pinned = opts.pinnedPubkey;
    this.clock = opts.now_ms ?? (() => BigInt(Date.now()));
    this.store = opts.store ?? new ActionStore({ now_ms: this.clock });
  }

  /** Issue an action, hand it to the responder to sign, and verify the result. Fail-closed. */
  async authorize(input: ActionInput, respond: Responder): Promise<Verdict> {
    const req = this.store.issue(input);
    const requestHash = this.store.get(req.request_id)!.expected_request_hash;
    const env = await respond({ request_id: req.request_id, request_hash: requestHash });
    return this.verify(env);
  }

  /** Verify an already-produced response envelope against its issued request. */
  verify(env: ResponseEnvelope): Verdict {
    const deps: VerifyDeps = {
      store: this.store,
      now_ms: this.clock,
      pinnedPubkey: this.pinned,
      recomputeRequestHash: (p: PendingRequest) => this.store.recompute(p),
    };
    return verifyAuthorization(env, deps);
  }
}
