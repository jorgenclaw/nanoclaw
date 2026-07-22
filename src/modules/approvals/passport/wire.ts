// Container↔host wire format for canonical params.
//
// The high-stakes MCP tool runs in the Bun agent container; the gate (AuthorizationService) runs in the
// Node host. They share NO code — they talk only through the session DBs as JSON. Canonical params,
// however, carry types JSON can't represent directly (u64 as bigint, bytes as Buffer). This module is
// the agreed-upon JSON-safe encoding for that boundary: u64 -> decimal string, bytes -> hex. The
// container tool MUST emit exactly this shape; the host handler decodes it here before authorizing.
//
// (This intentionally parallels durable-store.ts's internal params JSON. They are kept separate on
// purpose: that one is a private DB-column detail of one store; THIS one is a cross-process protocol
// boundary. Same shape today, but they answer to different owners and may evolve independently.)

import type { Params, ParamValue } from './canonical.js';

export type ParamWire = { t: ParamValue['t']; v: string | boolean };
export type ParamsWire = Record<string, ParamWire>;

export function paramsToWire(p: Params): ParamsWire {
  const o: ParamsWire = {};
  for (const [k, val] of Object.entries(p)) {
    switch (val.t) {
      case 'u64':
        o[k] = { t: 'u64', v: val.v.toString() };
        break;
      case 'str':
        o[k] = { t: 'str', v: val.v };
        break;
      case 'bool':
        o[k] = { t: 'bool', v: val.v };
        break;
      case 'bytes':
        o[k] = { t: 'bytes', v: val.v.toString('hex') };
        break;
    }
  }
  return o;
}

export function paramsFromWire(o: ParamsWire): Params {
  const out: Params = {};
  for (const [k, val] of Object.entries(o)) {
    switch (val.t) {
      case 'u64':
        out[k] = { t: 'u64', v: BigInt(val.v as string) };
        break;
      case 'str':
        out[k] = { t: 'str', v: val.v as string };
        break;
      case 'bool':
        out[k] = { t: 'bool', v: val.v as boolean };
        break;
      case 'bytes':
        out[k] = { t: 'bytes', v: Buffer.from(val.v as string, 'hex') };
        break;
      default:
        throw new Error(`unknown param wire type ${(val as ParamWire).t}`);
    }
  }
  return out;
}
