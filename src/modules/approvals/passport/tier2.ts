// Tier 2 — the fail-closed backstop at the OneCLI gateway callback.
//
// When the gateway holds a credentialed request (a manual_approval rule on a gated host), it asks the
// host whether to release the credential. This is the decision. It reads the `X-NanoClaw-Action-Id`
// header and redeems the single-use egress token Tier 1 minted:
//
//   • valid token  → APPROVE instantly (no card, no human wait), consuming the token (single-use).
//                    This is just correct gating; it happens regardless of enforce mode and is what
//                    makes a gated github_write release immediately instead of hanging on a card.
//   • gated host, no/invalid token → the DENY target. Denied only when enforce=true; in shadow mode it
//                    is logged ("would-deny") and the decision falls through to the existing flow so
//                    nothing is blocked while we watch.
//   • anything else (no token, host not gated) → null: not Tier-2's call, fall through to the card flow
//                    used by non-passport credentialed actions.
//
// Pure + injected (no singletons / config) so it is unit-testable. Fail-closed on exception only when
// enforcing; shadow never changes behavior.

import type { RedeemResult } from './egress-store.js';

const ACTION_ID_HEADER = 'x-nanoclaw-action-id';

// Tier-2 gates MUTATING calls only. Reads (GET/HEAD/OPTIONS) to a gated host pass through untouched —
// the credential they use is fine; the gate is for high-stakes *actions* (the WYSIWYS approval surface),
// and the typed tool (github_write) only ever issues these methods. Without this, a manual_approval rule
// that matches all methods would deny the agent's normal GitHub reads under enforcement.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface Tier2Request {
  id?: string;
  method: string;
  host: string;
  path: string;
  headers?: Record<string, string>;
}

/** Structurally satisfied by AuthorizationService. */
export interface Tier2Redeemer {
  redeem(claim: { actionId: string; method: string; host: string; path: string }): RedeemResult;
}

export interface Tier2Mode {
  enforce: boolean;
  /** Lowercased hosts that REQUIRE a token; a no-token held call to one of these is the deny target. */
  gatedHosts: string[];
}

export interface Tier2Outcome {
  /** 'approve' | 'deny' to decide here; null = fall through to the existing (card) flow. */
  decision: 'approve' | 'deny' | null;
  /** true when this is a would-have decision that was NOT applied (logged only). */
  shadow: boolean;
  reason: string;
}

/** Strip a trailing :port and lowercase — the gateway reports 'api.github.com:443'; tokens bind 'api.github.com'. */
export function normalizeHost(host: string): string {
  return host.replace(/:\d+$/, '').toLowerCase();
}

function findActionId(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === ACTION_ID_HEADER) return v;
  }
  return undefined;
}

export function decidePassportTier2(req: Tier2Request, redeemer: Tier2Redeemer, mode: Tier2Mode): Tier2Outcome {
  try {
    // Reads are never gated — only mutating methods can be high-stakes actions.
    if (!WRITE_METHODS.has(req.method.toUpperCase())) {
      return { decision: null, shadow: false, reason: 'non-mutating method — not gated' };
    }
    const host = normalizeHost(req.host);
    const actionId = findActionId(req.headers);
    const isGated = mode.gatedHosts.includes(host);

    // Neither a passport call nor a token-required host → not our decision.
    if (!actionId && !isGated) {
      return { decision: null, shadow: false, reason: 'not a passport-gated call' };
    }

    if (actionId) {
      const verdict = redeemer.redeem({ actionId, method: req.method, host, path: req.path });
      if (verdict.release) {
        return { decision: 'approve', shadow: false, reason: `release: ${verdict.reason}` };
      }
      // Token present but not redeemable (spent / expired / binding mismatch / unknown).
      if (mode.enforce) return { decision: 'deny', shadow: false, reason: `deny: ${verdict.reason}` };
      return { decision: null, shadow: true, reason: `would-deny (invalid token): ${verdict.reason}` };
    }

    // Gated host, no token at all — the canonical Tier-2 catch (ungated egress to a protected host).
    if (mode.enforce) return { decision: 'deny', shadow: false, reason: 'deny: gated host, no action-id token' };
    return { decision: null, shadow: true, reason: 'would-deny: gated host, no action-id token' };
  } catch (e) {
    const reason = 'exception: ' + (e instanceof Error ? e.message : String(e));
    if (mode.enforce) return { decision: 'deny', shadow: false, reason };
    return { decision: null, shadow: true, reason: `would-deny (${reason})` };
  }
}
