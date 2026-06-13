// Drift guard: prove the VENDORED canonical.ts still produces byte-identical preimages and hashes to
// the frozen protocol/test-vectors.json. If anyone hand-edits the vendored copy (or a re-copy drifts
// from the source of truth), these vectors break loudly. This is the contract anchor for the whole
// gateway side — the Passport (Rust) and this gateway MUST agree on every byte.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  requestHash,
  requestPreimage,
  responseHash,
  responsePreimage,
  DECISION,
  type AuthRequest,
  type AuthResponse,
  type Params,
} from "./canonical.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsPath = path.resolve(
  here,
  "../../../../groups/main/projects/keyos-authorization/protocol/test-vectors.json",
);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  vectors: Array<Record<string, any>>;
};

function toParams(raw: Record<string, { t: string; v: unknown }>): Params {
  const out: Params = {};
  for (const [k, val] of Object.entries(raw)) {
    switch (val.t) {
      case "u64":
        out[k] = { t: "u64", v: BigInt(val.v as string) };
        break;
      case "str":
        out[k] = { t: "str", v: val.v as string };
        break;
      case "bool":
        out[k] = { t: "bool", v: val.v as boolean };
        break;
      case "bytes":
        out[k] = { t: "bytes", v: Buffer.from(val.v as string, "hex") };
        break;
      default:
        throw new Error(`unknown param type ${val.t}`);
    }
  }
  return out;
}

describe("vendored canonical.ts matches frozen test-vectors.json (no drift)", () => {
  for (const vec of vectors.vectors) {
    it(vec.name, () => {
      const r = vec.request;
      const req: AuthRequest = {
        request_id: r.request_id,
        agent_id: r.agent_id,
        action: r.action,
        risk: r.risk,
        issued_at_ms: BigInt(r.issued_at_ms),
        expires_at_ms: BigInt(r.expires_at_ms),
        nonce: Buffer.from(r.nonce_hex, "hex"),
        params: toParams(r.params),
        display: r.display,
      };
      expect(requestPreimage(req).toString("hex")).toBe(vec.request_preimage_hex);
      expect(requestHash(req).toString("hex")).toBe(vec.request_hash_hex);

      const resp = vec.response;
      const decision =
        typeof resp.decision === "number"
          ? resp.decision
          : DECISION[resp.decision as "approve" | "deny"];
      const ar: AuthResponse = {
        request_hash: Buffer.from(resp.request_hash_hex, "hex"),
        decision,
        notes: resp.notes,
        signer_pubkey: Buffer.from(resp.signer_pubkey_hex, "hex"),
      };
      expect(responsePreimage(ar).toString("hex")).toBe(vec.response_preimage_hex);
      expect(responseHash(ar).toString("hex")).toBe(vec.response_hash_hex);
    });
  }
});
