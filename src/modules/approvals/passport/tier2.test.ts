// decidePassportTier2 — the Tier-2 backstop decision. Drives a real AuthorizationService (in-memory) so
// the redeem path is exercised end to end: a valid token releases; a spent/forged/missing token is the
// deny target under enforcement and a logged-only would-deny in shadow; non-gated calls fall through.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  AuthorizationService,
  EgressTokenStore,
  PassportGateway,
  SqliteActionStore,
  StandInPassport,
  autoApproveResponder,
  bodySha256,
  type AuthorizeRequest,
} from './index.js';
import { decidePassportTier2, normalizeHost, type Tier2Mode, type Tier2Request } from './tier2.js';

const passport = new StandInPassport();
const GATED: Tier2Mode = { enforce: false, gatedHosts: ['api.github.com'] };
const ENFORCE: Tier2Mode = { enforce: true, gatedHosts: ['api.github.com'] };

function service(db = new Database(':memory:')): AuthorizationService {
  return new AuthorizationService({
    gateway: new PassportGateway({ pinnedPubkey: passport.pubkey, store: new SqliteActionStore(db) }),
    egress: new EgressTokenStore(db),
    responder: autoApproveResponder(passport),
  });
}

const BODY = JSON.stringify({ title: 'hello' });

async function authorizeIssue(svc: AuthorizationService, actionId: string): Promise<void> {
  const req: AuthorizeRequest = {
    actionId,
    agentId: 'main',
    action: 'github_write',
    risk: 3,
    params: {
      method: { t: 'str', v: 'POST' },
      host: { t: 'str', v: 'api.github.com' },
      path: { t: 'str', v: '/repos/jorgenclaw/test/issues' },
      body_sha256: { t: 'bytes', v: bodySha256(BODY) },
    },
    display: 'Create issue',
    egress: { method: 'POST', host: 'api.github.com', path: '/repos/jorgenclaw/test/issues' },
  };
  const r = await svc.authorize(req);
  expect(r.authorized).toBe(true);
}

/** The held request as the gateway presents it (host carries :443; header key lowercased). */
function heldRequest(actionId?: string): Tier2Request {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (actionId) headers['x-nanoclaw-action-id'] = actionId;
  return { id: 'req-1', method: 'POST', host: 'api.github.com:443', path: '/repos/jorgenclaw/test/issues', headers };
}

describe('decidePassportTier2', () => {
  it('releases a held call carrying a valid token (and consumes it — single use)', async () => {
    const svc = service();
    await authorizeIssue(svc, 'act-1');

    const first = decidePassportTier2(heldRequest('act-1'), svc, GATED);
    expect(first.decision).toBe('approve');

    // Token spent — a replay of the same held call no longer releases.
    const replay = decidePassportTier2(heldRequest('act-1'), svc, ENFORCE);
    expect(replay.decision).toBe('deny');
    expect(replay.reason).toMatch(/spent|single-use/i);
  });

  it('a gated-host call with NO token: shadow logs would-deny + falls through; enforce denies', async () => {
    const svc = service();
    const shadow = decidePassportTier2(heldRequest(undefined), svc, GATED);
    expect(shadow.decision).toBe(null); // falls through to existing flow
    expect(shadow.shadow).toBe(true);
    expect(shadow.reason).toMatch(/would-deny/i);

    const enforced = decidePassportTier2(heldRequest(undefined), svc, ENFORCE);
    expect(enforced.decision).toBe('deny');
  });

  it('a forged/unknown token is denied under enforce, would-deny in shadow (never silently approved)', async () => {
    const svc = service();
    expect(decidePassportTier2(heldRequest('never-issued'), svc, ENFORCE).decision).toBe('deny');
    const shadow = decidePassportTier2(heldRequest('never-issued'), svc, GATED);
    expect(shadow.decision).toBe(null);
    expect(shadow.shadow).toBe(true);
  });

  it('a valid token releases EVEN in shadow mode (correct gating, not enforcement)', async () => {
    const svc = service();
    await authorizeIssue(svc, 'act-shadow');
    const out = decidePassportTier2(heldRequest('act-shadow'), svc, GATED);
    expect(out.decision).toBe('approve');
    expect(out.shadow).toBe(false);
  });

  it('a call to a non-gated host with no token is not Tier-2 business (falls through)', async () => {
    const svc = service();
    const out = decidePassportTier2({ id: 'r', method: 'GET', host: 'wttr.in', path: '/', headers: {} }, svc, ENFORCE);
    expect(out.decision).toBe(null);
    expect(out.shadow).toBe(false);
    expect(out.reason).toMatch(/not a passport-gated call/i);
  });

  it('a token bound to one endpoint will not release a different endpoint (binding holds)', async () => {
    const svc = service();
    await authorizeIssue(svc, 'act-bind');
    const wrongPath = { ...heldRequest('act-bind'), path: '/repos/evil/x/issues' };
    expect(decidePassportTier2(wrongPath, svc, ENFORCE).decision).toBe('deny');
  });

  it('normalizeHost strips port + lowercases', () => {
    expect(normalizeHost('api.github.com:443')).toBe('api.github.com');
    expect(normalizeHost('API.GitHub.com')).toBe('api.github.com');
  });
});
