// ⚠️ VENDORED — byte-identical copy of
//   groups/main/projects/keyos-authorization/protocol/reference/verify.ts (the frozen source of truth).
//   DO NOT hand-edit the security logic here. Only the relative import extension was changed
//   (./canonical.ts → ./canonical.js) so it compiles under the host's NodeNext module resolution.
//   To update: re-copy from the reference and re-apply that one extension fix. canonical.test.ts
//   re-checks the frozen test vectors against this copy to prove no drift.
//
// NanoClaw-Auth gateway verifier — REFERENCE IMPLEMENTATION (EVO / OneCLI side).
//
// This is the security chokepoint. It decides whether to release a credential / execute a gated
// action. EVERY path that is not a fully valid, fresh, pinned-signer APPROVE returns release:false.
// There is exactly one `release: true` exit and it is guarded by all checks. Any thrown error is
// caught and converted to fail-closed. This mirrors requirement D (fail-safe = deny).
//
// The production OneCLI integration (mcp-server/src/verify.ts in the build-plan layout) should be a
// thin adapter over this function — do not re-derive the checks there.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { DECISION, responseHash } from "./canonical.js";

/** A request the gateway has issued a nonce for and is waiting on. Persisted server-side. */
export interface PendingRequest {
  request_id: string;
  nonce: Buffer; // 32-byte single-use value bound into the request hash
  issued_at_ms: bigint;
  expires_at_ms: bigint; // hard deadline; gateway clock is authoritative, never the Passport's
  expected_request_hash: Buffer; // 32-byte snapshot computed at issuance
  state: "issued" | "consumed";
}

export interface NonceStore {
  get(request_id: string): PendingRequest | undefined;
  /** Atomically mark consumed. MUST be idempotent and concurrency-safe in production. */
  consume(request_id: string): void;
}

/** Exactly the fields the Passport returns. signer_pubkey is echoed but must equal the pin. */
export interface ResponseEnvelope {
  request_id: string;
  decision: number; // DECISION.*
  notes: string;
  signer_pubkey: Buffer; // 33-byte compressed secp256k1
  signature: Buffer; // 64-byte compact r||s, low-S
  returned_request_hash: Buffer; // 32-byte hash the Passport claims it signed over
}

export interface VerifyDeps {
  store: NonceStore;
  now_ms(): bigint;
  /** TOFU-pinned device public key (33-byte compressed). Established once at pairing. */
  pinnedPubkey: Buffer;
  /**
   * Recompute the request hash from the action the gateway is ABOUT TO EXECUTE, using the pending
   * request's nonce/metadata. This binds the signature to live execution semantics, catching any
   * drift between issuance and release (TOCTOU). Throwing here → fail-closed.
   */
  recomputeRequestHash(p: PendingRequest): Buffer;
}

export type Verdict = {
  release: boolean;
  decision: "approve" | "deny" | "none";
  reason: string;
};

function block(reason: string, decision: "deny" | "none" = "none"): Verdict {
  return { release: false, decision, reason };
}

export function verifyAuthorization(env: ResponseEnvelope, deps: VerifyDeps): Verdict {
  try {
    const p = deps.store.get(env.request_id);
    if (!p) return block("unknown request_id");
    if (p.state !== "issued") return block("request not in 'issued' state (replay / already consumed)");
    if (deps.now_ms() > p.expires_at_ms) return block("request expired (fail-safe deny)");

    // 1) Bind to live execution: recompute from the action we are about to run.
    const live = deps.recomputeRequestHash(p);
    if (live.length !== 32) return block("recomputed request hash wrong length");
    if (!live.equals(p.expected_request_hash)) return block("intended action drifted since issuance (TOCTOU)");

    // 2) WYSIWYS: what the Passport signed over must equal what we will execute.
    if (env.returned_request_hash.length !== 32) return block("returned request hash wrong length");
    if (!env.returned_request_hash.equals(live)) return block("WYSIWYS mismatch: signed action != executable action");

    // 3) Signer identity must be the pinned device key (a serial number is NOT identity).
    if (env.signer_pubkey.length !== 33 || !env.signer_pubkey.equals(deps.pinnedPubkey))
      return block("unknown signer (pubkey not pinned)");

    // 4) Decision must be a valid byte.
    if (env.decision !== DECISION.approve && env.decision !== DECISION.deny)
      return block("invalid decision byte");

    // 5) Verify the ECDSA signature over the response hash (which binds request_hash+decision+notes+signer).
    if (env.signature.length !== 64) return block("signature must be 64-byte compact (r||s)");
    const msg = responseHash({
      request_hash: env.returned_request_hash,
      decision: env.decision,
      notes: env.notes,
      signer_pubkey: env.signer_pubkey,
    });
    const sigOk = secp256k1.verify(env.signature, msg, env.signer_pubkey, { lowS: true });
    if (!sigOk) return block("signature invalid (or high-S)");

    // 6) Consume the nonce BEFORE acting — prevents concurrent reuse of a valid approval.
    if (env.decision === DECISION.deny) {
      deps.store.consume(env.request_id);
      return { release: false, decision: "deny", reason: "human denied (signed)" };
    }
    deps.store.consume(env.request_id);
    return { release: true, decision: "approve", reason: "valid, fresh, pinned-signer approval" };
  } catch (e) {
    return block("exception → fail-closed: " + (e instanceof Error ? e.message : String(e)));
  }
}
