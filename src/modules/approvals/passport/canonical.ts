// ⚠️ VENDORED — byte-identical copy of
//   groups/main/projects/keyos-authorization/protocol/reference/canonical.ts (the frozen source of truth).
//   DO NOT hand-edit. This file only imports node:crypto, so it is an exact copy (no extension fixes
//   needed). Any change to the encoding here is a breaking protocol change; canonical.test.ts re-checks
//   the frozen test vectors against this copy. To update, re-copy from the reference.
//
// NanoClaw-Auth canonical action-hash encoding — REFERENCE IMPLEMENTATION (gateway side, TS).
//
// This is the single source of truth for how an authorization request/response is reduced to the
// 32-byte hashes that get signed and verified. The Passport (Rust) and the EVO gateway (TypeScript)
// MUST produce byte-identical preimages and hashes for identical logical inputs. The contract is
// pinned by ../test-vectors.json — any change that moves a vector is a breaking protocol change.
//
// Design rules (see ../PROTOCOL.md for the full spec and rationale):
//   - Explicit length-prefixed binary encoding. NEVER JSON. No floats anywhere.
//   - All integers big-endian (network order).
//   - All strings NFC-normalized then UTF-8 (ASCII is unaffected; this only pins non-ASCII text).
//   - Every variable-length field is u32-BE length-prefixed → the encoding is injective
//     (no "ab|c" vs "a|bc" concatenation collisions).
//   - Domain-separated + version-bound: a signed auth hash can never collide with a Bitcoin sighash
//     or a different protocol version.
//
// Dependency-free on purpose: uses only node:crypto so it runs as the vector generator.

import { createHash } from "node:crypto";

// --- Protocol constants (changing any of these is a breaking change) ---------------------------

/** Exact domain-separation prefix. 17 bytes: "nanoclaw-auth/v1" + NUL. */
export const DOMAIN = Buffer.from("nanoclaw-auth/v1\0", "latin1");

export const MSG_REQUEST = 0x01; // request preimage tag
export const MSG_RESPONSE = 0x02; // response preimage tag

export const RISK = { low: 0x00, medium: 0x01, high: 0x02, critical: 0x03 } as const;
export const DECISION = { deny: 0x00, approve: 0x01 } as const;

// Typed-map value tags
const T_U64 = 0x01;
const T_STR = 0x02;
const T_BYTES = 0x03;
const T_BOOL = 0x04;

// --- Primitive encoders ------------------------------------------------------------------------

function u8(n: number): Buffer {
  if (n < 0 || n > 0xff || !Number.isInteger(n)) throw new Error(`u8 out of range: ${n}`);
  return Buffer.from([n]);
}
function u32be(n: number): Buffer {
  if (n < 0 || n > 0xffffffff || !Number.isInteger(n)) throw new Error(`u32 out of range: ${n}`);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function u64be(n: bigint): Buffer {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${n}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}
/** length-prefixed raw bytes: u32_be(len) || bytes */
function lenBytes(b: Buffer): Buffer {
  return Buffer.concat([u32be(b.length), b]);
}
/** length-prefixed NFC-UTF8 string */
function lenStr(s: string): Buffer {
  return lenBytes(Buffer.from(s.normalize("NFC"), "utf8"));
}

// --- Typed param map ---------------------------------------------------------------------------
// The binding parameters of an action (e.g. {amount_sats:u64, destination:str}). Encoded as a
// canonical map: entries sorted byte-lexicographically by NFC-UTF8 key, each entry self-describing
// its value type. Duplicate keys (after NFC) are rejected. This is generic so new action types add
// params without touching the hashing core.

export type ParamValue =
  | { t: "u64"; v: bigint }
  | { t: "str"; v: string }
  | { t: "bytes"; v: Buffer }
  | { t: "bool"; v: boolean };

export type Params = Record<string, ParamValue>;

function encodeValue(val: ParamValue): Buffer {
  switch (val.t) {
    case "u64":
      return Buffer.concat([u8(T_U64), u64be(val.v)]);
    case "str":
      return Buffer.concat([u8(T_STR), lenStr(val.v)]);
    case "bytes":
      return Buffer.concat([u8(T_BYTES), lenBytes(val.v)]);
    case "bool":
      return Buffer.concat([u8(T_BOOL), u8(val.v ? 1 : 0)]);
    default:
      throw new Error(`unknown param type`);
  }
}

export function encodeMap(params: Params): Buffer {
  const entries = Object.entries(params).map(([k, v]) => ({
    key: Buffer.from(k.normalize("NFC"), "utf8"),
    value: encodeValue(v),
  }));
  // reject duplicate keys after NFC
  const seen = new Set<string>();
  for (const e of entries) {
    const h = e.key.toString("hex");
    if (seen.has(h)) throw new Error(`duplicate param key after NFC: ${e.key.toString("utf8")}`);
    seen.add(h);
  }
  entries.sort((a, b) => Buffer.compare(a.key, b.key));
  const parts: Buffer[] = [u32be(entries.length)];
  for (const e of entries) parts.push(lenBytes(e.key), e.value);
  return Buffer.concat(parts);
}

// --- Request / Response preimages --------------------------------------------------------------

export interface AuthRequest {
  request_id: string; // gateway-issued unique id
  agent_id: string; // which agent proposed the action (audit only — gateway authors the binding)
  action: string; // verb, from the closed action registry (e.g. "lightning_payment")
  risk: number; // RISK.*
  issued_at_ms: bigint; // gateway clock at issuance (unix ms)
  expires_at_ms: bigint; // hard fail-safe-deny deadline (unix ms)
  nonce: Buffer; // 32-byte gateway CSPRNG nonce, single-use
  params: Params; // binding parameters of the exact action the gateway will execute
  display: string; // gateway-authored human summary shown on the Passport (also bound)
}

export function requestPreimage(r: AuthRequest): Buffer {
  return Buffer.concat([
    DOMAIN,
    u8(MSG_REQUEST),
    lenStr(r.request_id),
    lenStr(r.agent_id),
    lenStr(r.action),
    u8(r.risk),
    u64be(r.issued_at_ms),
    u64be(r.expires_at_ms),
    lenBytes(r.nonce),
    encodeMap(r.params),
    lenStr(r.display),
  ]);
}

export function requestHash(r: AuthRequest): Buffer {
  return sha256(requestPreimage(r));
}

export interface AuthResponse {
  request_hash: Buffer; // 32-byte hash of the exact request that was approved/denied
  decision: number; // DECISION.*
  notes: string; // optional human note entered on the Passport ("" if none)
  signer_pubkey: Buffer; // 33-byte compressed secp256k1 pubkey of the signing key
}

export function responsePreimage(resp: AuthResponse): Buffer {
  if (resp.request_hash.length !== 32) throw new Error("request_hash must be 32 bytes");
  if (resp.decision !== DECISION.approve && resp.decision !== DECISION.deny)
    throw new Error("decision must be approve(1) or deny(0)");
  if (resp.signer_pubkey.length !== 33) throw new Error("signer_pubkey must be 33 bytes (compressed)");
  return Buffer.concat([
    DOMAIN,
    u8(MSG_RESPONSE),
    lenBytes(resp.request_hash),
    u8(resp.decision),
    lenStr(resp.notes),
    lenBytes(resp.signer_pubkey),
  ]);
}

/** The 32-byte value that is actually ECDSA-signed by the Passport and verified by the gateway. */
export function responseHash(resp: AuthResponse): Buffer {
  return sha256(responsePreimage(resp));
}

export function sha256(b: Buffer): Buffer {
  return createHash("sha256").update(b).digest();
}
