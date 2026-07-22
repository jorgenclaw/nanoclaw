// Stand-in Passport responder — a SOFTWARE secp256k1 signer that plays the role of the real
// Passport Prime over os/mcp. It produces the exact wire envelope (ResponseEnvelope) the gateway
// verifier consumes, so the real hardware device drops in later WITHOUT changing the gateway.
//
// This is the host-side twin of the in-app Rust software signer. It exists so the whole gateway
// round trip is testable offline while the USB / os-mcp transport is Foundation-blocked. When the
// real transport lands, replace `respond()` with a call out to the device; nothing else moves.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createHash } from 'node:crypto';
import { DOMAIN, responseHash, type AuthResponse } from './canonical.js';
import type { ResponseEnvelope } from './verify.js';

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export interface SignArgs {
  request_id: string;
  /** The 32-byte request_hash the device is signing a decision over. */
  request_hash: Buffer;
  /** DECISION.approve | DECISION.deny (from canonical.ts). */
  decision: number;
  notes?: string;
}

export class StandInPassport {
  private readonly priv: Buffer;
  /** 33-byte compressed secp256k1 public key — this is what the gateway pins (TOFU). */
  readonly pubkey: Buffer;

  /**
   * Deterministic, seed-derived key — mirrors the in-app signer's derivation shape
   * SHA256(DOMAIN ‖ context ‖ seed). Deterministic so tests pin a stable pubkey; pass a distinct
   * `seedLabel` to simulate a DIFFERENT (unpinned) device.
   */
  constructor(seedLabel = 'DEMO-SEED-stand-in-passport-v1') {
    this.priv = sha256(DOMAIN, Buffer.from('signer-key-v1', 'utf8'), Buffer.from(seedLabel, 'utf8'));
    this.pubkey = Buffer.from(secp256k1.getPublicKey(this.priv, true));
  }

  /**
   * Sign a decision over a request_hash, producing the exact envelope the gateway verifies.
   * Signature is 64-byte compact r||s, low-S (noble enforces it with { lowS: true }).
   */
  respond(args: SignArgs): ResponseEnvelope {
    if (args.request_hash.length !== 32) throw new Error('request_hash must be 32 bytes');
    const notes = args.notes ?? '';
    const resp: AuthResponse = {
      request_hash: args.request_hash,
      decision: args.decision,
      notes,
      signer_pubkey: this.pubkey,
    };
    const msg = responseHash(resp); // the 32-byte value actually signed
    const signature = Buffer.from(secp256k1.sign(msg, this.priv, { lowS: true }));
    return {
      request_id: args.request_id,
      decision: args.decision,
      notes,
      signer_pubkey: this.pubkey,
      signature,
      returned_request_hash: args.request_hash,
    };
  }
}
