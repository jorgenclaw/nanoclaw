/**
 * lightning_pay — the first Option B (host-executed) gated tool.
 *
 * A Lightning payment is high-stakes and irreversible, and — unlike a GitHub write — it is NOT an HTTPS
 * call the OneCLI gateway can intercept (it is a WebSocket NWC call). So there is no Tier-2 backstop to
 * lean on; the only way to gate it unbypassably is for the HOST to hold the credential and execute the
 * payment. This tool therefore does NOT pay anything itself. It:
 *
 *   1. Builds the canonical request — amount_sats + destination (a human label) + the EXACT invoice hash
 *      (bolt11_sha256) go INTO params, so the Passport's signature covers what the human approves
 *      (WYSIWYS), plus a one-line `summary`.
 *   2. Writes a `lightning_pay` system message (carrying the signed params AND the raw bolt11 the host
 *      needs to actually pay) to outbound.db, then BLOCKS polling inbound.db for the host's verdict.
 *   3. The host runs issue→sign→verify, checks sha256(bolt11) matches the signed hash, and ONLY then
 *      executes the payment with the host-held NWC credential, returning the result here.
 *
 * NOTE: until the real Passport lands, the host responder is a software stand-in that AUTO-APPROVES — so
 * today this proves the round trip + host execution, not a human approval. Until Phase 2 removes the
 * NWC credential from the container, a raw `nwc-wallet pay` from bash still bypasses this gate.
 */
import { createHash, randomUUID } from 'crypto';

import { getMessageIn, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface PayResult {
  ok: boolean;
  amountSats?: number;
  preimage?: string;
  error?: string;
}
interface Verdict {
  authorized: boolean;
  reason: string;
  payment: PayResult | null;
}

/** Block until the host writes the verdict row, or the deadline passes. Fail-closed on timeout. */
async function awaitVerdict(actionId: string, timeoutMs: number): Promise<Verdict> {
  const deadline = Date.now() + timeoutMs;
  const id = `passport-resp-${actionId}`;
  while (Date.now() < deadline) {
    const row = getMessageIn(id);
    if (row) {
      markCompleted([row.id]);
      try {
        const parsed = JSON.parse(row.content) as { authorized?: boolean; reason?: string; payment?: PayResult | null };
        return { authorized: parsed.authorized === true, reason: parsed.reason ?? '', payment: parsed.payment ?? null };
      } catch {
        return { authorized: false, reason: 'unparseable host verdict', payment: null };
      }
    }
    await sleep(1000);
  }
  return { authorized: false, reason: `authorization timed out after ${Math.round(timeoutMs / 1000)}s`, payment: null };
}

export const lightningPay: McpToolDefinition = {
  tool: {
    name: 'lightning_pay',
    description:
      'Pay a Lightning (BOLT11) invoice through the Passport authorization gate. The payment is authorized on the Passport and EXECUTED BY THE HOST — this tool never holds the wallet credential. Use this for ANY Lightning payment; do NOT call the nwc-wallet CLI directly for pay/zap. bolt11 is the invoice string (lnbc...). amount_sats and destination are what the human approves and MUST match the invoice (amount_sats = the invoice amount in sats; destination = a human label like the Lightning address or recipient name). summary is a one-line human description shown on the approval surface.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        bolt11: { type: 'string', description: 'The BOLT11 invoice to pay (starts with lnbc)' },
        amount_sats: { type: 'number', description: 'Amount in sats the human approves (must match the invoice)' },
        destination: { type: 'string', description: 'Human label for the recipient (e.g. "scott@jorgenclaw.ai")' },
        summary: { type: 'string', description: 'One-line human description shown on the approval surface' },
        timeout: { type: 'number', description: 'Seconds to wait for authorization (default 120)' },
      },
      required: ['bolt11', 'amount_sats', 'destination', 'summary'],
    },
  },
  async handler(args) {
    const bolt11 = String(args.bolt11 ?? '').trim();
    const amountSats = Number(args.amount_sats ?? 0);
    const destination = String(args.destination ?? '');
    const summary = String(args.summary ?? '');
    const timeoutMs = ((args.timeout as number) || 120) * 1000;

    if (!bolt11.toLowerCase().startsWith('lnbc')) return err('bolt11 must be a BOLT11 invoice (starts with lnbc)');
    if (!Number.isFinite(amountSats) || amountSats <= 0) return err('amount_sats must be a positive number');
    if (!destination) return err('destination is required (the human-readable recipient label)');
    if (!summary) return err('summary is required (it is what a human approves)');

    const actionId = randomUUID();

    // Canonical params: amount + destination + the EXACT invoice hash are signed (WYSIWYS). The raw bolt11
    // is sent alongside (unsigned) so the host can execute; the host re-checks sha256(bolt11) == this hash.
    const params = {
      amount_sats: { t: 'u64', v: String(Math.floor(amountSats)) },
      destination: { t: 'str', v: destination },
      bolt11_sha256: { t: 'bytes', v: sha256Hex(bolt11) },
      summary: { t: 'str', v: summary },
    };

    writeMessageOut({
      id: `passport-req-${actionId}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'lightning_pay',
        actionId,
        canonicalAction: 'lightning_payment',
        risk: 3, // RISK.critical
        params,
        bolt11,
        display: `Pay ${Math.floor(amountSats)} sats to ${destination} — ${summary}`,
      }),
    });

    const verdict = await awaitVerdict(actionId, timeoutMs);
    if (!verdict.authorized) {
      return err(`authorization denied: ${verdict.reason}. No payment was made.`);
    }
    const p = verdict.payment;
    if (!p || !p.ok) {
      return err(`authorized, but the payment did not complete: ${p?.error ?? 'unknown wallet error'} (action ${actionId})`);
    }
    return ok(
      `Paid ${p.amountSats ?? amountSats} sats to ${destination} (action ${actionId}).` +
        (p.preimage ? `\npreimage: ${p.preimage}` : ''),
    );
  },
};

registerTools([lightningPay]);
