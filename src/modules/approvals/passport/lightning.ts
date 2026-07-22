// Option B (host-executed) Tier-1 gate — Lightning payments.
//
// Unlike github_write (Option A), a Lightning payment is NOT an HTTPS call the OneCLI gateway can MITM —
// it is a WebSocket NWC call. There is no network chokepoint to backstop, so the ONLY way to make it
// unbypassable is for the host to hold the credential and EXECUTE the payment itself. The container's
// lightning_pay tool can only *request*: it writes a `lightning_pay` system message with the typed,
// signed params and BLOCKS (the ask_user_question pattern). This handler runs the gate and, only on a
// verified APPROVE, executes the payment with the host-held NWC credential, then writes the result back.
//
// WYSIWYS binding: the human approves amount_sats + destination + the EXACT invoice (params carry
// `bolt11_sha256`). The raw bolt11 travels alongside (unsigned, needed to actually pay); before paying,
// the host recomputes sha256(bolt11) and refuses if it does not match the signed hash — so the agent
// cannot get "100 sats to X" approved and then pay a different invoice.
//
// Phase 1 (this file): advisory. The credential is still in the container too, so a raw `nwc-wallet pay`
// from bash bypasses this — exactly where github_write sat before Tier 2. Phase 2 removes
// NWC_CONNECTION_STRING from the container (container-runner.ts) once the other wallet ops + the daily
// zap routine route through host-executed tools; after that this is the only way to spend.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../../delivery.js';
import { unguarded } from '../../../guard/index.js';
import { insertMessage } from '../../../db/session-db.js';
import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';
import type { AuthorizationService } from './authorization-service.js';
import { getAuthorizationService } from './service-host.js';
import { RISK, type Params } from './canonical.js';
import { paramsFromWire, type ParamsWire } from './wire.js';

const execFileAsync = promisify(execFile);

export const LIGHTNING_PAY_ACTION = 'lightning_pay';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/modules/approvals/passport/lightning.js → project root is four levels up.
const projectRoot = path.resolve(__dirname, '../../../..');
const WALLET_SCRIPT = path.join(projectRoot, 'tools/nwc-wallet/index.js');
const HOST_SPENDING_PATH = path.join(projectRoot, 'groups/main/config/passport-lightning-spending.json');

/** The outcome of actually executing the payment on the host. */
export interface LightningPayResult {
  ok: boolean;
  amountSats?: number;
  preimage?: string;
  /** Set when the payment did not complete (NWC error, spending-cap rejection, or a confirmation gate). */
  error?: string;
  /** Trimmed raw stdout for debugging / audit. */
  raw?: string;
}

/** Executes a paid invoice. Injected so tests never touch a real wallet and the handler stays pure. */
export type LightningExecutor = (bolt11: string) => Promise<LightningPayResult>;

/** Write the verdict (and any payment result) into inbound.db so the blocked tool poll resolves. */
function writeVerdict(
  inDb: Database.Database,
  actionId: string,
  authorized: boolean,
  reason: string,
  payment?: LightningPayResult,
): void {
  insertMessage(inDb, {
    id: `passport-resp-${actionId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'lightning_payment', actionId, authorized, reason, payment: payment ?? null }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

function boundHash(params: Params): Buffer | null {
  const v = params.bolt11_sha256;
  return v?.t === 'bytes' ? v.v : null;
}

/**
 * Pure handler (service + executor injected) so it is unit-testable without the singleton or a real
 * wallet. Fail-closed: any parse/auth/runtime failure writes an `authorized:false` verdict rather than
 * leaving the tool to hang. The executor runs ONLY after a verified approval and a matching invoice hash.
 */
export async function handleLightningPay(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  service: AuthorizationService,
  executor: LightningExecutor,
): Promise<void> {
  const actionId = content.actionId as string;
  if (!actionId) {
    log.warn('lightning_pay missing actionId — cannot respond', { sessionId: session.id });
    return;
  }

  try {
    const params = paramsFromWire((content.params as ParamsWire) ?? {});
    const bolt11 = typeof content.bolt11 === 'string' ? content.bolt11.trim() : '';
    if (!bolt11) {
      writeVerdict(inDb, actionId, false, 'missing bolt11 invoice');
      return;
    }

    // The signed params must commit to this exact invoice (WYSIWYS — see header).
    const signedHash = boundHash(params);
    if (!signedHash) {
      writeVerdict(inDb, actionId, false, 'params missing bolt11_sha256 binding');
      return;
    }
    const actualHash = createHash('sha256').update(bolt11, 'utf8').digest();
    if (!actualHash.equals(signedHash)) {
      writeVerdict(inDb, actionId, false, 'bolt11 does not match the signed invoice hash — refusing to pay');
      return;
    }

    const result = await service.authorizeLocal({
      actionId,
      // Bind to the REAL originating agent group, not a container-supplied value the agent could forge.
      agentId: session.agent_group_id,
      action: String(content.canonicalAction ?? 'lightning_payment'),
      risk: Number(content.risk ?? RISK.critical),
      params,
      display: String(content.display ?? ''),
      ...(typeof content.ttlMs === 'number' ? { ttlMs: content.ttlMs } : {}),
    });

    if (!result.authorized) {
      writeVerdict(inDb, actionId, false, result.reason);
      log.info('lightning_pay denied', { sessionId: session.id, actionId, reason: result.reason });
      return;
    }

    // Verified APPROVE — the HOST executes the payment with the host-held credential.
    const payment = await executor(bolt11);
    writeVerdict(inDb, actionId, true, result.reason, payment);
    log.info('lightning_pay handled', {
      sessionId: session.id,
      actionId,
      authorized: true,
      paid: payment.ok,
      amountSats: payment.amountSats,
    });
  } catch (err) {
    writeVerdict(inDb, actionId, false, 'host exception → fail-closed');
    log.error('lightning_pay errored', { sessionId: session.id, actionId, err });
  }
}

/**
 * Default executor: run the host NWC wallet CLI with the host-held credential. The container never holds
 * this — that is the enforcement. Parses the wallet's JSON output into a structured result.
 *
 * NOTE: this is the live-money path. It is wired but exercised for real ONLY with Scott present (like the
 * first github_write). The wallet's own spending caps (daily / per-tx / confirm-above) still apply.
 */
export function nwcPayExecutor(): LightningExecutor {
  return async (bolt11: string): Promise<LightningPayResult> => {
    const env = readEnvFile([
      'NWC_CONNECTION_STRING',
      'NWC_DAILY_CAP_SATS',
      'NWC_PER_TRANSACTION_CAP_SATS',
      'NWC_CONFIRM_ABOVE_SATS',
    ]);
    if (!env.NWC_CONNECTION_STRING) {
      return { ok: false, error: 'host NWC_CONNECTION_STRING not configured' };
    }
    try {
      // process.execPath = the exact node binary running the host. Bare 'node' fails under the systemd
      // --user service, whose minimal PATH excludes the nvm node (spawn node ENOENT).
      const { stdout } = await execFileAsync(process.execPath, [WALLET_SCRIPT, 'pay', bolt11], {
        env: { ...process.env, ...env, NWC_SPENDING: HOST_SPENDING_PATH },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      });
      const raw = stdout.length > 2000 ? stdout.slice(0, 2000) + '…' : stdout;
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        if (parsed.success === true) {
          return {
            ok: true,
            amountSats: typeof parsed.amount_sats === 'number' ? parsed.amount_sats : undefined,
            preimage: typeof parsed.preimage === 'string' ? parsed.preimage : undefined,
            raw,
          };
        }
        // needs_confirmation (cap gate) or a structured error → not paid.
        const reason = parsed.needs_confirmation
          ? `payment exceeds a spending cap and needs confirmation (${String(parsed.message ?? '')})`
          : String(parsed.error ?? 'wallet reported failure');
        return { ok: false, error: reason, raw };
      } catch {
        // Non-JSON stdout but exit 0 — treat conservatively as unconfirmed.
        return { ok: false, error: 'unparseable wallet output', raw };
      }
    } catch (e) {
      // Non-zero exit (wallet error path) or timeout.
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };
}

registerDeliveryAction(
  LIGHTNING_PAY_ACTION,
  (content, session, inDb) => handleLightningPay(content, session, inDb, getAuthorizationService(), nwcPayExecutor()),
  unguarded(
    'gated by the Passport signed-authorization handshake (host executes the payment itself only ' +
      'after a verified APPROVE, WYSIWYS-bound to the invoice hash) — see ' +
      '.nanoclaw-migrations/07-passport-approval-gates.md',
  ),
);
