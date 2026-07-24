# 07 — Passport Approval-Gate Subsystem

Added since the original guide (commits `40163873`..`f611ec9b`, 2026-06/07), entirely new — not present when `index.md` was written on 2026-05-08. Local-only, not upstream.

```
40163873 feat(approvals): offline Passport gateway verifier harness + shadow observer
0365b2f6 feat(approvals): durable SQLite-backed nonce/pin store for the Passport gateway
461d03f7 feat(passport): Tier-1 authorization service + single-use egress token
49fb3927 feat(passport): Tier-1 Option-A host half — passport_authorize round trip
387795a4 refactor(passport): derive egress binding from signed params (provenance)
eec9953f feat(passport): Tier-2 backstop at the OneCLI callback (shadow-first)
2b5babac fix(passport): Tier-2 gates mutating methods only — reads always pass
14a5182a feat(container): github_write — first Tier-1 (Option A) gated tool
37ab289b feat(passport): lightning_pay — Option B host-executed Tier-1 gate
515c66f2 fix(passport): nwcPayExecutor uses process.execPath, not bare 'node'
f611ec9b feat(passport): nostr_post — Option B host-executed Tier-1 gate
```

**Apply this section after the base guide's steps 3–8 (skills, MCP servers, scripts, config, source, container customizations) are in place** — Passport wraps `src/modules/approvals/onecli-approvals.ts` and adds new MCP tools alongside the existing ones, so the base fork needs to exist first. See `index.md`'s "Skill Interactions" section for how this relates to the (currently unused) `security-policy.ts` engine described in the base guide — no conflict, purely additive.

---

## Part A — Core Primitives

### 1. Tier-1 vs Tier-2 — what each gates

**Tier 1** is the primary WYSIWYS ("what you sign is what you see") gate. It runs *before* a high-stakes agent action becomes a credentialed call. A typed MCP tool (e.g. `lightning_pay`, `nostr_post`, `github_write`) hands its own typed params — not an opaque HTTP tuple — to `AuthorizationService`, which issues a nonce, asks a "Passport" signer to sign a decision, and verifies fail-closed against a TOFU-pinned device key. Two host-execution patterns exist:

- **Option A** (`authorize()` / `passport_authorize` delivery action, `delivery.ts`): used when there *is* a network chokepoint the OneCLI gateway can MITM (e.g. `github_write` over HTTPS). Container executes the actual HTTP call itself; the host only authorizes and mints a single-use **egress token** the container must present via the `X-NanoClaw-Action-Id` header. No credential changes hands at Tier 1 — Tier 2 is what actually releases it.
- **Option B** (`authorizeLocal()` / e.g. `lightning_pay`, `nostr_post` delivery actions): used when there's *no* HTTP chokepoint to intercept — Lightning is a WebSocket NWC call, Nostr signing goes over a Unix socket. Since OneCLI can't MITM either, the **host itself executes the action** with a credential the container never holds, immediately after a verified APPROVE. No egress token is minted (there's no gateway to redeem it against) — the verified APPROVE *is* the authorization.

Both patterns share the same underlying `PassportGateway.authorize()` issue→sign→verify handshake; they differ only in what happens after `release:true`.

**Tier 2** (`tier2.ts`, wired in `onecli-approvals.ts`) is the fail-closed *backstop* at the OneCLI gateway callback, only relevant to Option A. When OneCLI intercepts a credentialed HTTP call to a `manual_approval`-gated host, `decidePassportTier2()` decides:
- a call carrying a valid, unspent, unexpired `X-NanoClaw-Action-Id` token whose bound `{method,host,path}` matches → **approve instantly**, consuming the token (no human-facing approval card).
- a call to a **gated host** (in `PASSPORT_GATED_HOSTS`) with no/invalid token → the deny target — actually denied only if `PASSPORT_TIER2_ENFORCE=true`; otherwise logged as `[passport-tier2] SHADOW would-deny` and falls through unchanged.
- **reads only gate mutations**: `decidePassportTier2` short-circuits GET/HEAD/OPTIONS to `decision:null` before any token check (commit `2b5babac`) — otherwise a host-level `manual_approval` rule (which matches all methods) would break normal agent reads once enforced.
- anything non-passport (no token, non-gated host) → `null`, falls through to the pre-existing manual-approval-card flow untouched.

Both env flags default to inert: `PASSPORT_TIER2_ENFORCE` defaults `false` (shadow), `PASSPORT_GATED_HOSTS` defaults `''` (no host gated) — see `src/config.ts:86-97`.

### 2. Single-use egress token / authorization flow — exact mechanics

**Canonicalization (`canonical.ts`).** ⚠️ This file (and `verify.ts`) are marked **VENDORED — byte-identical copies** of `groups/main/projects/keyos-authorization/protocol/reference/{canonical,verify}.ts`, an install-specific "frozen protocol" reference tree *outside* `src/`. `canonical.test.ts` loads `groups/main/projects/keyos-authorization/protocol/test-vectors.json` to drift-guard the copy. **This is the single biggest reproduction gotcha**: a fresh engineer on a clean checkout has no `groups/main/projects/keyos-authorization/` tree at all — the reference protocol and test vectors must either be reconstructed from scratch (the encoding rules below fully specify it) or the vendoring relationship abandoned in favor of treating `canonical.ts`/`verify.ts` as first-party.

Encoding rules: explicit length-prefixed binary, never JSON, no floats, all integers big-endian, all strings NFC-normalized UTF-8, every variable-length field u32-BE length-prefixed (injective — no concatenation collisions), domain-separated (`DOMAIN = "nanoclaw-auth/v1\0"`, 17 bytes) and version-bound.

```ts
export const DOMAIN = Buffer.from('nanoclaw-auth/v1\0', 'latin1');
export const MSG_REQUEST = 0x01;
export const MSG_RESPONSE = 0x02;
export const RISK = { low: 0x00, medium: 0x01, high: 0x02, critical: 0x03 } as const;
export const DECISION = { deny: 0x00, approve: 0x01 } as const;

export type ParamValue =
  | { t: 'u64'; v: bigint } | { t: 'str'; v: string }
  | { t: 'bytes'; v: Buffer } | { t: 'bool'; v: boolean };
export type Params = Record<string, ParamValue>;

export function encodeMap(params: Params): Buffer; // u32be(count) || sorted [lenBytes(key) || tag || value]*
                                                     // sorted byte-lexicographically by NFC key; dup keys throw

export interface AuthRequest {
  request_id: string; agent_id: string; action: string; risk: number;
  issued_at_ms: bigint; expires_at_ms: bigint; nonce: Buffer /* 32B CSPRNG */;
  params: Params; display: string;
}
export function requestPreimage(r: AuthRequest): Buffer; // DOMAIN||0x01||lenStr(id)||lenStr(agent)||lenStr(action)
                                                            // ||u8(risk)||u64be(issued)||u64be(expires)||lenBytes(nonce)
                                                            // ||encodeMap(params)||lenStr(display)
export function requestHash(r: AuthRequest): Buffer; // sha256(requestPreimage(r))

export interface AuthResponse {
  request_hash: Buffer /* 32B */; decision: number; notes: string; signer_pubkey: Buffer /* 33B compressed */;
}
export function responsePreimage(resp: AuthResponse): Buffer; // DOMAIN||0x02||lenBytes(hash)||u8(decision)||lenStr(notes)||lenBytes(pubkey)
export function responseHash(resp: AuthResponse): Buffer; // the actual signed value
```

**Signing (`signer.ts`).** `StandInPassport` is a **software** secp256k1 signer via `@noble/curves`, standing in for the real hardware device. Deterministic key derivation: `priv = SHA256(DOMAIN ‖ "signer-key-v1" ‖ seedLabel)`, default `seedLabel = 'DEMO-SEED-stand-in-passport-v1'`. `pubkey` is 33-byte compressed. `respond({request_id, request_hash, decision, notes?})` builds an `AuthResponse`, signs `responseHash(resp)` with `secp256k1.sign(msg, priv, {lowS:true})` → 64-byte compact `r||s`, returns a `ResponseEnvelope`. **This is explicitly not a human approval** — everywhere it's used it's flagged as offline/dev-only.

**Verification (`verify.ts`, also vendored).** `verifyAuthorization(env, deps)` — the sole security chokepoint, **exactly one `release:true` exit**, every other path returns `release:false`, all exceptions caught and converted to fail-closed:
```ts
export interface VerifyDeps {
  store: NonceStore; now_ms(): bigint; pinnedPubkey: Buffer /* 33B */;
  recomputeRequestHash(p: PendingRequest): Buffer;
}
export type Verdict = { release: boolean; decision: 'approve'|'deny'|'none'; reason: string };
export function verifyAuthorization(env: ResponseEnvelope, deps: VerifyDeps): Verdict;
```
Check order: (1) request known + state `'issued'` (not already consumed/replayed), (2) not expired (`now_ms() > expires_at_ms`), (3) **TOCTOU**: `recomputeRequestHash` (live action) must equal the `expected_request_hash` snapshotted at issuance, (4) WYSIWYS: `env.returned_request_hash` must equal that live hash, (5) `env.signer_pubkey` must byte-equal the pinned key (33B), (6) decision byte valid, (7) 64-byte signature verified over `responseHash(...)` via `secp256k1.verify(sig, msg, pubkey, {lowS:true})`, (8) **nonce consumed before acting**, on both approve and deny, to block concurrent reuse.

**Authorization service (`authorization-service.ts`).**
```ts
export interface AuthorizeRequest {
  actionId: string; agentId: string; action: string; risk: number; params: Params;
  display: string; egress: EgressBinding; ttlMs?: number; egressTtlMs?: number;
}
export interface AuthorizeLocalRequest { // Option B — no egress field
  actionId: string; agentId: string; action: string; risk: number; params: Params;
  display: string; ttlMs?: number;
}
export type AuthorizeResult =
  | { authorized: true; actionId: string; reason: string; verdict: Verdict }
  | { authorized: false; actionId: string; reason: string; verdict: Verdict | null };

class AuthorizationService {
  constructor(opts: { gateway: PassportGateway; egress: EgressTokenStore; responder: Responder });
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;       // Option A: mints egress token on release
  async authorizeLocal(req: AuthorizeLocalRequest): Promise<AuthorizeResult>; // Option B: no token
  redeem(claim: RedeemClaim): RedeemResult;                                // Tier 2's decision surface
}
export function bodySha256(body: Buffer | string): Buffer;         // sha256 helper for egress.bodySha256
export function autoApproveResponder(passport: StandInPassport, notes?): Responder; // DEV/TEST ONLY
export function autoDenyResponder(passport: StandInPassport, notes?): Responder;
```
Default egress TTL 60s (`DEFAULT_EGRESS_TTL_MS`), separate from the signing-handshake TTL (default 90s, set in the store).

**Egress token store (`egress-store.ts`).** After a verified fresh APPROVE, the `actionId` becomes a one-time token bound to `{method,host,path,body_sha256?}`:
```ts
export interface EgressBinding { method: string; host: string; path: string; bodySha256?: Buffer; }
export interface MintInput extends EgressBinding { actionId: string; expiresAtMs: bigint; }
export interface RedeemClaim { actionId: string; method: string; host: string; path: string; bodySha256?: Buffer; }
export type RedeemResult = { release: true; reason: string } | { release: false; reason: string };

class EgressTokenStore {
  constructor(db: Database.Database, opts?: { now_ms?: () => bigint });
  mint(input: MintInput): void;      // throws on duplicate actionId
  redeem(claim: RedeemClaim): RedeemResult; // atomic; non-consuming on binding mismatch (see below)
  state(actionId: string): 'authorized'|'spent'|undefined; // read-only peek
}
```
Redeem runs inside a `better-sqlite3` transaction: unknown id / wrong state / expired → deny; method/host/path mismatch → deny **without consuming** the token (a wrong-tuple probe must not burn a legitimate caller's token — the unguessable actionId is already the real protection); body hash checked only if it was minted with one; successful spend flips state via `UPDATE ... WHERE state='authorized'` and checks `changes===1` to catch a lost race. As of commit `387795a4`, the binding is **derived from the signed params themselves** (`method`/`host`/`path` as `str` params, `body_sha256` as a `bytes` param), not a separate caller-supplied field — this closes the seam where a tool could sign one call and bind the token to a different one. Token binds method+host+path **only, never the body** (OneCLI only hands Tier 2 a truncated body preview); body integrity instead rides on the Passport's signature over `params.body_sha256`.

### 3. Remaining key exports

**`durable-store.ts` — `SqliteActionStore`** (production `NonceStore` impl, drop-in for the in-memory `ActionStore`):
```ts
class SqliteActionStore implements NonceStore {
  constructor(db: Database.Database, opts?: { now_ms?: () => bigint });
  now_ms(): bigint;
  issue(input: ActionInput): AuthRequest;         // mints 32B nonce, snapshots expected_request_hash, state='issued'
  get(request_id: string): PendingRequest | undefined;
  consume(request_id: string): void;              // UPDATE ... WHERE state='issued' (idempotent, race-safe)
  recompute(p: PendingRequest): Buffer;            // re-derives requestHash from persisted row
  setPinnedPubkey(pubkey: Buffer): void;           // TOFU pin, upsert into passport_pin
  getPinnedPubkey(): Buffer | undefined;
}
```
Params are stored as JSON with u64→decimal string, bytes→hex (`paramsToJSON`/`paramsFromJSON`) — key order doesn't matter since `encodeMap` re-sorts during hash recompute.

**`store.ts` — `ActionStore`** (in-memory harness twin, same `NonceStore` shape, same `issue/get/consume/recompute` signatures over a `Map`).

**`index.ts` — `PassportGateway`** (glue class, barrel export point):
```ts
export interface PassportStore extends NonceStore {
  issue(input: ActionInput): AuthRequest; recompute(p: PendingRequest): Buffer; now_ms(): bigint;
}
export type Responder = (args: {request_id: string; request_hash: Buffer}) => ResponseEnvelope | Promise<ResponseEnvelope>;
class PassportGateway {
  readonly store: PassportStore;
  constructor(opts: { pinnedPubkey: Buffer; now_ms?: () => bigint; store?: PassportStore });
  async authorize(input: ActionInput, respond: Responder): Promise<Verdict>;
  verify(env: ResponseEnvelope): Verdict;
}
```
Also re-exports everything from `store.js`, `durable-store.js` (just `SqliteActionStore`), `signer.js`, `verify.js`, `egress-store.js`, `authorization-service.js`, and `canonical.js` (`export *`).

**`wire.ts`** — JSON-safe cross-process param encoding for the container↔host boundary (container is Bun, can't share TS with the Node host; only talks via session DBs as JSON):
```ts
export type ParamWire = { t: ParamValue['t']; v: string | boolean };
export type ParamsWire = Record<string, ParamWire>;
export function paramsToWire(p: Params): ParamsWire;   // u64->decimal string, bytes->hex
export function paramsFromWire(o: ParamsWire): Params;
```

**`service-host.ts`** — process-wide singleton:
```ts
export function getAuthorizationService(): AuthorizationService; // lazy singleton, backed by data/passport.db
export function __setAuthorizationServiceForTest(svc: AuthorizationService | null): void;
```
On first run with no pinned key, TOFU-pins `StandInPassport`'s pubkey and logs a loud `log.warn`. Thereafter an unpinned/different signer fails closed. Nonce store and egress store **share the same SQLite file** (`data/passport.db`) so a restart keeps the signing handshake and the Tier-2 redeem record consistent.

**`delivery.ts`** — Option A host handler:
```ts
export const PASSPORT_AUTHORIZE_ACTION = 'passport_authorize';
export async function handlePassportAuthorize(content, session, inDb, service: AuthorizationService): Promise<void>;
registerDeliveryAction(PASSPORT_AUTHORIZE_ACTION, (content, session, inDb) =>
  handlePassportAuthorize(content, session, inDb, getAuthorizationService()));
```
Mirrors `src/cli/delivery-action.ts`'s `cli_request`/`cli_response` pattern: container writes an outbound `kind:'system'` message and blocks polling `inbound.db`; this handler writes the verdict back as `id: 'passport-resp-<actionId>'`, `trigger: 0` (resolves the poll without waking the agent). Binds `agentId` to `session.agent_group_id` — **never a container-supplied value**, closing a forgery vector.

**`tier2.ts`** — pure/injected decision function:
```ts
export interface Tier2Request { id?: string; method: string; host: string; path: string; headers?: Record<string,string>; }
export interface Tier2Redeemer { redeem(claim: {actionId,method,host,path}): RedeemResult; } // AuthorizationService satisfies this
export interface Tier2Mode { enforce: boolean; gatedHosts: string[]; }
export interface Tier2Outcome { decision: 'approve'|'deny'|null; shadow: boolean; reason: string; }
export function normalizeHost(host: string): string; // strips :port, lowercases
export function decidePassportTier2(req: Tier2Request, redeemer: Tier2Redeemer, mode: Tier2Mode): Tier2Outcome;
```

**`nostr-post.ts`** — Option B for Nostr (parallel structure to `lightning.ts`, the related Option B file for Lightning payments):
```ts
export const NOSTR_POST_ACTION = 'nostr_post';
export type NostrPostExecutor = (subclaw: string, body: string) => Promise<{ok:boolean; eventId?:string; error?:string}>;
export async function handleNostrPost(content, session, inDb, service: AuthorizationService, executor: NostrPostExecutor): Promise<void>;
export function clawstrPostExecutor(): NostrPostExecutor; // default: runs tools/nostr-signer/clawstr-post.js via execFile
```
Requires `params.subclaw` and `params.body` (both `str`); host-side default risk `RISK.critical`. Uses `process.execPath` (not bare `'node'`) to invoke the script (see gotcha below). Signer socket resolved as `${XDG_RUNTIME_DIR}/nostr-signer.sock`, falling back to `/run/user/1000/nostr-signer.sock`.

### 4. SQL schema (durable-store.ts + egress-store.ts)

Both create tables idempotently (`CREATE TABLE IF NOT EXISTS`) on construction, no formal migration file — explicitly flagged in comments as "should graduate to `src/db/migrations/` when wired into the live host." Stored in `data/passport.db` (separate SQLite file, not `data/v2.db`).

```sql
CREATE TABLE IF NOT EXISTS passport_pending (
  request_id            TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL,
  action                TEXT NOT NULL,
  risk                   INTEGER NOT NULL,
  issued_at_ms           TEXT NOT NULL,   -- bigint ms stored as decimal string
  expires_at_ms          TEXT NOT NULL,
  nonce                  BLOB NOT NULL,   -- 32 bytes
  params_json            TEXT NOT NULL,
  display                TEXT NOT NULL,
  expected_request_hash  BLOB NOT NULL,   -- 32 bytes, snapshotted at issuance
  state                  TEXT NOT NULL DEFAULT 'issued'  -- 'issued' | 'consumed'
);

CREATE TABLE IF NOT EXISTS passport_pin (
  id     INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  pubkey BLOB NOT NULL                        -- 33-byte compressed secp256k1, TOFU
);

CREATE TABLE IF NOT EXISTS passport_egress (
  action_id        TEXT PRIMARY KEY,
  method           TEXT NOT NULL,
  host             TEXT NOT NULL,
  path             TEXT NOT NULL,
  body_sha256      BLOB,               -- nullable; only checked on redeem if present
  authorized_at_ms TEXT NOT NULL,
  expires_at_ms    TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'authorized'  -- 'authorized' | 'spent'
);
```

### 5. Non-obvious gotchas

- **Vendored protocol files with an off-tree source of truth.** `canonical.ts` and `verify.ts` are marked "DO NOT hand-edit" copies of `groups/main/projects/keyos-authorization/protocol/reference/*.ts`, and `canonical.test.ts` loads `groups/main/projects/keyos-authorization/protocol/test-vectors.json` — a path under a *group folder*, not `src/`. This tree does not exist on a clean checkout; a migration must either fabricate it or repoint the test to inline vectors. `verify.ts`'s only diff from its reference is one import-extension fix (`./canonical.ts` → `./canonical.js`) for NodeNext resolution.
- **`process.execPath`, not bare `'node'`, when the host spawns child processes.** Both `lightning.ts` (`nwcPayExecutor`) and `nostr-post.ts` (`clawstrPostExecutor`) had to switch from `execFile('node', ...)` to `execFile(process.execPath, ...)` — the systemd `--user` service runs with a minimal `PATH` that excludes `nvm`'s node, causing `spawn node ENOENT` even though the gate authorized correctly (commit `515c66f2`, proven against a live Lightning payment).
- **Tier-2 must gate mutating methods only.** A `manual_approval` OneCLI rule matches *all* HTTP methods; without the `WRITE_METHODS = {POST,PUT,PATCH,DELETE}` short-circuit in `decidePassportTier2`, enabling enforcement would break the agent's normal GETs to a gated host (commit `2b5babac`).
- **Egress redeem must be non-consuming on a binding mismatch.** A wrong-tuple probe (attacker guesses/observes an action-id but sends the wrong method/host/path) must not burn the legitimate caller's real token.
- **Re-pinning the TOFU device key must never be automatic.** `service-host.ts` only auto-pins when *nothing* is pinned yet (first run); comments flag that swapping in the real Passport device later requires a human-gated re-pairing step, referencing `PROTOCOL.md §5.1` (also off-tree, under the vendored `keyos-authorization` project).
- **`autoApproveResponder`/`autoDenyResponder` are dev/test-only** and make no security claim — every call site currently wired into the live host (`service-host.ts`) uses `autoApproveResponder(StandInPassport)`, meaning **Tier 1 currently auto-approves everything** until a real device transport replaces the responder. This is explicitly "Phase 1 / advisory" per header comments in `lightning.ts` and `nostr-post.ts`: the container still has direct paths (`NWC_CONNECTION_STRING` in the container env, `clawstr-post` mounted via nostr-dm channel config) that bypass the gate entirely; "Phase 2" (removing those) is not yet done.
- **Default state is fully inert.** `PASSPORT_TIER2_ENFORCE` defaults `false` and `PASSPORT_GATED_HOSTS` defaults empty, so Tier 2 changes no behavior until explicitly configured.
- **`nostr-post.ts` and `lightning.ts` are Option B twins** — same shape, differing only in the executor and domain-specific WYSIWYS binding (Lightning additionally re-verifies `sha256(bolt11)` against a signed `bolt11_sha256` param before paying, since the raw invoice text has to travel unsigned alongside the signed hash).

---

## Part B — Tool Integrations & Wiring

This covers how the Part A primitives get connected to real MCP tools and to the existing OneCLI `configureManualApproval` callback. All files below are additive — no existing file's exported surface changed shape, only imports/callback bodies grew.

### 1. Tier-2 backstop wired into the existing OneCLI callback

`src/modules/approvals/onecli-approvals.ts` already had a `configureManualApproval` callback (`handleRequest`) that builds a human approval card. The change wraps that callback with a Tier-2 check that runs *first* and can short-circuit it:

```ts
import { decidePassportTier2 } from './passport/tier2.js';
import { getAuthorizationService } from './passport/service-host.js';
import { PASSPORT_GATED_HOSTS, PASSPORT_TIER2_ENFORCE } from '../../config.js';

handle = onecli.configureManualApproval(async (request: ApprovalRequest): Promise<Decision> => {
  logShadowObservation(request); // observe-only; does not affect the decision

  // Tier-2 backstop: redeem the Passport egress token. A valid token releases instantly
  // (no card); a gated-host call without one is denied (enforce) or logged-only (shadow).
  const t2 = decidePassportTier2(request, getAuthorizationService(), {
    enforce: PASSPORT_TIER2_ENFORCE,
    gatedHosts: PASSPORT_GATED_HOSTS,
  });
  if (t2.decision) {
    return t2.decision; // 'approve' | 'deny' — skip the human card entirely
  }
  if (t2.shadow) {
    log.warn('[passport-tier2] SHADOW (not enforced)', { id: request.id, host: request.host, path: request.path, reason: t2.reason });
  }

  try {
    return await handleRequest(request); // pre-existing human-card fallthrough, unchanged
  } catch (err) { /* ... return 'deny' */ }
});
```

`decidePassportTier2` returns `{ decision: 'approve'|'deny'|undefined, shadow, reason }`. `undefined` means "not applicable / not enforced" — falls through to the normal human-approval card path, completely unchanged from before Passport existed.

A `logShadowObservation` call was also added just above this, purely to log the header set OneCLI's gateway forwards (redacting sensitive values) — proof-of-concept for header-based action-id correlation. Can be omitted in a minimal port.

**Bundled but not Passport-specific**: `onecli-approvals.ts` also gained `ONECLI_GATEWAY_URL` passed explicitly into the `OneCLI` SDK constructor — required so the approval long-poller hits a host-reachable proxy address rather than the SDK's auto-resolved (unreachable) localhost.

### 2. Gated MCP tools — the container↔host `passport_authorize` round trip

Three tools live under `container/agent-runner/src/mcp-tools/`, each a standalone module with its own `writeMessageOut`/`getMessageIn` polling — no shared "gated tool" helper or base class. Each follows the identical shape:

1. Build canonical `params` (typed `{ t: 'str'|'u64'|'bytes', v }`) so the signed request covers the real values (WYSIWYS).
2. `writeMessageOut({ id: 'passport-req-<actionId>', kind: 'system', content: JSON.stringify({ action, actionId, canonicalAction, risk, params, display, ... }) })` — a `kind:'system'` row in the container's `outbound.db`.
3. **Block** in a `while (Date.now() < deadline)` loop calling `getMessageIn('passport-resp-<actionId>')` against the container's `inbound.db` every 1s (fail-closed on timeout — `authorized: false`), then `markCompleted([row.id])` once found.
4. Only on `authorized: true`, perform (or receive the already-performed result of) the actual side effect.

This reuses the existing outbound-write / inbound-poll pair the `ask_user_question` interactive-question flow already used — no new host↔container transport was invented.

**Two flavors** distinguished by *who executes the side effect*:

- **Option A (`github_write.ts`)** — the container still makes the actual HTTP call (via `curl`, through `HTTPS_PROXY` + OneCLI's injected credential), *after* getting the verdict, stamping `X-NanoClaw-Action-Id: <actionId>` so Tier-2 can redeem the token if OneCLI intercepts it.
- **Option B (`lightning-pay.ts`, `nostr-post.ts`)** — the container never holds the credential. It sends the unsigned raw payload alongside the signed canonical params; the **host** runs `issue → sign → verify` and then *itself* executes the payment/post (host-side files `src/modules/approvals/passport/lightning.ts` and `nostr-post.ts`, registered via `registerDeliveryAction(LIGHTNING_PAY_ACTION, ...)` / `registerDeliveryAction(NOSTR_POST_ACTION, ...)`), returning the execution result in the same verdict JSON written back to `inbound.db`.

Representative snippet — `github-write.ts` (Option A):

```ts
const params = {
  method: { t: 'str', v: method },
  host: { t: 'str', v: GITHUB_HOST },
  path: { t: 'str', v: path },
  body_sha256: { t: 'bytes', v: bodyHashHex },
  summary: { t: 'str', v: summary },
};

writeMessageOut({
  id: `passport-req-${actionId}`,
  kind: 'system',
  content: JSON.stringify({
    action: 'passport_authorize',
    actionId,
    canonicalAction: 'github_write',
    risk: 3,
    params,
    display: `GitHub ${method} ${path} — ${summary}`,
  }),
});

const verdict = await awaitVerdict(actionId, timeoutMs); // polls getMessageIn(`passport-resp-${actionId}`)
if (!verdict.authorized) return err(`authorization denied: ${verdict.reason}. The GitHub call was NOT made.`);
// only now: curl with X-NanoClaw-Action-Id header, honoring HTTPS_PROXY + OneCLI's injected token
```

`lightning-pay.ts` and `nostr-post.ts` are structurally identical except: (a) their `action` field is their own tool name (routes to their own host-side delivery-action handler, not the generic Tier-1 `passport_authorize` handler), and (b) the verdict payload additionally carries the host-executed result since the host performed the action.

Zod-equivalent `inputSchema` (plain JSON Schema — this codebase doesn't use zod for MCP tool params):
- `github_write`: `method` (POST/PATCH/PUT/DELETE, required), `path` (required, must start with `/`), `body` (optional object), `summary` (required), `timeout` (optional, default 300s).
- `lightning_pay`: `bolt11` (required, must start with `lnbc`), `amount_sats` (required, must match invoice), `destination` (required, human label), `summary` (required), `timeout` (optional, default 120s).
- `nostr_post`: `subclaw` (required), `body` (required), `timeout` (optional, default 120s).

### 3. MCP registration (`mcp-tools/index.ts`)

No special-casing — the barrel just imports each module for its side effect, and each module calls `registerTools([...])` at its own top level:

```ts
import './github-write.js';
import './lightning-pay.js';
import './nostr-post.js';
```

added alongside existing tool imports, before `startMcpServer()`.

### 4. `poll-loop.ts` / `destinations.ts` — no changes needed

Grepped both for "passport": zero matches. The blocking round trip is entirely self-contained inside each gated tool's handler function. The main poll loop just calls the MCP tool handler and waits for it to return, indistinguishable from any other slow tool call.

On the host side, verdict write-back reuses existing infra: `registerDeliveryAction(ACTION_NAME, handler)` from `src/delivery.ts` and `insertMessage(inDb, {...})` from `src/db/session-db.js`, writing `passport-resp-<actionId>` with `trigger: 0` (resolves the poll without waking the agent for a fresh turn).

### 5. Env vars

| Var | Default | Purpose |
|---|---|---|
| `PASSPORT_TIER2_ENFORCE` | unset → `false` (shadow mode) | `'true'` flips Tier-2 from log-only to actually denying ungated-host credentialed calls that lack a redeemable egress token. |
| `PASSPORT_GATED_HOSTS` | unset → `[]` (empty) | Comma-separated lowercased hostnames (e.g. `api.github.com`) requiring a valid Passport token under enforcement. |

Both read in `src/config.ts` (~lines 86–97), host-side only. The three MCP tools are unconditionally registered (no feature-flag gate) once their import line is present.

### Reproduction checklist

1. Port `src/modules/approvals/passport/*.ts` (Part A) — including resolving the vendored `groups/main/projects/keyos-authorization/` dependency (gotcha above).
2. Add `PASSPORT_TIER2_ENFORCE` / `PASSPORT_GATED_HOSTS` to `config.ts`.
3. Apply the `onecli-approvals.ts` callback wrapper (Part B §1).
4. Add the three side-effect imports to `approvals/index.ts` (`./passport/delivery.js`, `./passport/lightning.js`, `./passport/nostr-post.js`).
5. Add the three tool files under `container/agent-runner/src/mcp-tools/` and their imports to `mcp-tools/index.ts`.
6. No changes needed to `poll-loop.ts` or `destinations.ts`.
7. New dependency: `@noble/curves` (secp256k1 for `signer.ts`/`verify.ts`) — see `10-scheduling-and-deps.md` for the full new-dependency list.
