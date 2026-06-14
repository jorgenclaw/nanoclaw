// Tier 1 — the primary WYSIWYS gate, host-side.
//
// This is where a high-stakes agent action is authorized BEFORE it ever becomes a credentialed HTTP
// call. The MCP tool handler (which holds the typed intent — e.g. lightning_payment{amount_sats,
// destination}) calls authorize() with those typed params plus the exact HTTP request it is about to
// make. authorize():
//   1. issues the action into the durable nonce store (snapshotting the canonical request_hash),
//   2. asks the Passport (stand-in today, real device over os/mcp later) to sign a decision,
//   3. verifies the signature fail-closed against the TOFU-pinned device key (verify.ts), and
//   4. ONLY on a fresh, pinned APPROVE, mints a single-use egress token bound to that HTTP request.
// The tool then stamps `X-NanoClaw-Action-Id: <actionId>` on its call. Tier 2 (the OneCLI callback)
// later calls redeem() to decide whether to release the credential.
//
// Because the params are the tool's OWN typed arguments, the human signs EXACTLY what the agent
// intends — no degradation to an opaque HTTP tuple. That is the whole point of Option B.
//
// Nothing here touches the live credential path on its own: authorize() returns a decision and a
// token; it does not release anything. Wiring redeem() into the real OneCLI callback (Tier 2) is a
// separate, deliberately-gated step.

import { createHash } from 'node:crypto';
import { DECISION, type Params } from './canonical.js';
// Type-only: PassportGateway and Responder live in ./index.js, which re-exports this module — a
// type-only import keeps the dependency compile-time so there is no runtime import cycle.
import type { PassportGateway, Responder } from './index.js';
import { StandInPassport } from './signer.js';
import { EgressTokenStore, type EgressBinding, type RedeemClaim, type RedeemResult } from './egress-store.js';
import type { Verdict } from './verify.js';

/** Default window between a verified approval and the credentialed call that redeems it. Short on
 *  purpose: the call should follow the signature immediately. Separate from the signing-handshake TTL. */
const DEFAULT_EGRESS_TTL_MS = 60_000;

export interface AuthorizeRequest {
  /** Unique per call. Becomes the canonical request_id, the egress token id, and the
   *  X-NanoClaw-Action-Id header value — one id end to end. The caller mints it (e.g. a uuid). */
  actionId: string;
  /** Originating agent identity (agent group id), bound into the canonical request. */
  agentId: string;
  /** Canonical action name, e.g. 'lightning_payment'. Part of the WYSIWYS contract. */
  action: string;
  /** Risk level (canonical RISK.*). */
  risk: number;
  /** The tool's OWN typed parameters — what the human actually approves. */
  params: Params;
  /** Human-readable one-line summary shown on the Passport screen. */
  display: string;
  /** The exact HTTP request the credentialed call will make, so the egress token binds to it. */
  egress: EgressBinding;
  /** Signing-handshake TTL (issuance → signature). Default 90s (store default). */
  ttlMs?: number;
  /** Egress-token TTL (approval → credentialed call). Default 60s. */
  egressTtlMs?: number;
}

export type AuthorizeResult =
  | { authorized: true; actionId: string; reason: string; verdict: Verdict }
  | { authorized: false; actionId: string; reason: string; verdict: Verdict | null };

/** Like AuthorizeRequest but with NO egress binding — for host-executed actions (Option B) that have no
 *  network chokepoint to redeem a token against. The authorization itself is the gate. */
export interface AuthorizeLocalRequest {
  actionId: string;
  agentId: string;
  action: string;
  risk: number;
  params: Params;
  display: string;
  ttlMs?: number;
}

export interface AuthorizationServiceOptions {
  gateway: PassportGateway;
  egress: EgressTokenStore;
  /** Turns an issued request into a signed envelope — the Passport. Stand-in signer today. */
  responder: Responder;
}

export class AuthorizationService {
  private readonly gateway: PassportGateway;
  private readonly egress: EgressTokenStore;
  private readonly responder: Responder;

  constructor(opts: AuthorizationServiceOptions) {
    this.gateway = opts.gateway;
    this.egress = opts.egress;
    this.responder = opts.responder;
  }

  /**
   * Tier 1. Run the full issue → sign → verify handshake and, only on a verified APPROVE, mint the
   * single-use egress token. Fail-closed: any failure (denied, unpinned signer, duplicate id, thrown
   * error) returns authorized:false and mints NO token, so Tier 2 will later deny the call.
   */
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    try {
      const verdict = await this.gateway.authorize(
        {
          request_id: req.actionId,
          agent_id: req.agentId,
          action: req.action,
          risk: req.risk,
          params: req.params,
          display: req.display,
          ttl_ms: req.ttlMs,
        },
        this.responder,
      );

      if (!verdict.release) {
        return { authorized: false, actionId: req.actionId, reason: verdict.reason, verdict };
      }

      const expiresAtMs = this.gateway.store.now_ms() + BigInt(req.egressTtlMs ?? DEFAULT_EGRESS_TTL_MS);
      this.egress.mint({
        actionId: req.actionId,
        method: req.egress.method,
        host: req.egress.host,
        path: req.egress.path,
        bodySha256: req.egress.bodySha256,
        expiresAtMs,
      });

      return { authorized: true, actionId: req.actionId, reason: verdict.reason, verdict };
    } catch (e) {
      return {
        authorized: false,
        actionId: req.actionId,
        reason: 'authorize exception → fail-closed: ' + (e instanceof Error ? e.message : String(e)),
        verdict: null,
      };
    }
  }

  /**
   * Tier 1 for HOST-EXECUTED actions (Option B — e.g. a Lightning payment). Runs the SAME issue → sign →
   * verify handshake as authorize(), but mints NO egress token: there is no OneCLI gateway in the path to
   * redeem one against, because the host executes the action itself with a credential the container never
   * holds. The verified APPROVE *is* the authorization. Fail-closed: any failure returns authorized:false.
   */
  async authorizeLocal(req: AuthorizeLocalRequest): Promise<AuthorizeResult> {
    try {
      const verdict = await this.gateway.authorize(
        {
          request_id: req.actionId,
          agent_id: req.agentId,
          action: req.action,
          risk: req.risk,
          params: req.params,
          display: req.display,
          ttl_ms: req.ttlMs,
        },
        this.responder,
      );

      if (!verdict.release) {
        return { authorized: false, actionId: req.actionId, reason: verdict.reason, verdict };
      }
      return { authorized: true, actionId: req.actionId, reason: verdict.reason, verdict };
    } catch (e) {
      return {
        authorized: false,
        actionId: req.actionId,
        reason: 'authorizeLocal exception → fail-closed: ' + (e instanceof Error ? e.message : String(e)),
        verdict: null,
      };
    }
  }

  /**
   * Tier 2's decision surface. Atomically redeem the single-use egress token for the call being
   * released. Fail-closed by construction (EgressTokenStore.redeem).
   */
  redeem(claim: RedeemClaim): RedeemResult {
    return this.egress.redeem(claim);
  }
}

/** SHA-256 of a request body — the value to pass as egress.bodySha256 / RedeemClaim.bodySha256. */
export function bodySha256(body: Buffer | string): Buffer {
  return createHash('sha256').update(body).digest();
}

/**
 * Build a Responder from a StandInPassport that AUTO-APPROVES every request. DEV / TEST / offline-harness
 * ONLY — it stands in for a human pressing "approve" on the device. The real Passport responder returns
 * the human's actual decision; never ship this as the responder on a path that gates a real credential.
 */
export function autoApproveResponder(passport: StandInPassport, notes = 'stand-in auto-approve'): Responder {
  return ({ request_id, request_hash }) =>
    passport.respond({ request_id, request_hash, decision: DECISION.approve, notes });
}

/** Build a Responder that AUTO-DENIES — for testing the deny path / a "reject" stand-in. */
export function autoDenyResponder(passport: StandInPassport, notes = 'stand-in auto-deny'): Responder {
  return ({ request_id, request_hash }) =>
    passport.respond({ request_id, request_hash, decision: DECISION.deny, notes });
}
