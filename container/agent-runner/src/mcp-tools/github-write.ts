/**
 * github_write — the first Tier-1 (Option A) gated tool.
 *
 * A mutating GitHub API call (POST/PATCH/PUT/DELETE) is a high-stakes, credentialed action: the OneCLI
 * gateway injects the GitHub token. Before making it, this tool asks the host to authorize the EXACT
 * call via the Passport gate:
 *
 *   1. Build the canonical request — the wire identity (method/host/path/body_sha256) goes INTO params
 *      so the Passport's signature covers the real bytes (WYSIWYS), plus a human `summary`.
 *   2. Write a `passport_authorize` system message to outbound.db and BLOCK, polling inbound.db for the
 *      host's verdict (the ask_user_question pattern). The host runs issue→sign→verify and, on approval,
 *      mints a single-use egress token bound to method+host+path.
 *   3. ONLY on "authorized", make the call with `curl` (which honours HTTPS_PROXY + the OneCLI CA), adding
 *      `X-NanoClaw-Action-Id: <actionId>` so the Tier-2 backstop can redeem the token. On denial, refuse.
 *
 * Reads (GET) are not gated here — they don't mutate and the gate is for credentialed writes.
 *
 * NOTE: until the real Passport lands, the host responder is a software stand-in that AUTO-APPROVES — so
 * today this proves the plumbing (round trip + header passthrough + proxied credentialed call), not a
 * human approval. The approval surface becomes the Passport Prime screen later.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';

import { getMessageIn, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

const GITHUB_HOST = 'api.github.com';
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

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

interface Verdict {
  authorized: boolean;
  reason: string;
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
        const parsed = JSON.parse(row.content) as { authorized?: boolean; reason?: string };
        return { authorized: parsed.authorized === true, reason: parsed.reason ?? '' };
      } catch {
        return { authorized: false, reason: 'unparseable host verdict' };
      }
    }
    await sleep(1000);
  }
  return { authorized: false, reason: `authorization timed out after ${Math.round(timeoutMs / 1000)}s` };
}

export const githubWrite: McpToolDefinition = {
  tool: {
    name: 'github_write',
    description:
      'Make a mutating GitHub API call (create/update/delete issues, PRs, comments, etc.) through the Passport authorization gate. The request is authorized before it is sent. Use for ANY GitHub write — do not use curl/gh directly for writes. method is POST/PATCH/PUT/DELETE; path is relative to https://api.github.com (e.g. "/repos/owner/repo/issues"); body is the JSON request body object; summary is a one-line human description of what this does (shown on the approval surface).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', description: 'POST, PATCH, PUT, or DELETE' },
        path: { type: 'string', description: 'API path relative to https://api.github.com, must start with /' },
        body: { type: 'object', description: 'JSON request body (omit for DELETE with no body)' },
        summary: { type: 'string', description: 'One-line human description shown on the approval surface' },
        timeout: { type: 'number', description: 'Seconds to wait for authorization (default 300)' },
      },
      required: ['method', 'path', 'summary'],
    },
  },
  async handler(args) {
    const method = String(args.method ?? '').toUpperCase();
    const path = String(args.path ?? '');
    const summary = String(args.summary ?? '');
    const timeoutMs = ((args.timeout as number) || 300) * 1000;

    if (!WRITE_METHODS.has(method)) return err(`method must be one of ${[...WRITE_METHODS].join(', ')}`);
    if (!path.startsWith('/')) return err('path must start with / (relative to https://api.github.com)');
    if (!summary) return err('summary is required (it is what a human approves)');

    const hasBody = args.body !== undefined && args.body !== null;
    const bodyStr = hasBody ? JSON.stringify(args.body) : '';
    const bodyHashHex = sha256Hex(bodyStr);
    const actionId = randomUUID();

    // Canonical params: wire identity is IN params so the signature covers it (WYSIWYS).
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

    const verdict = await awaitVerdict(actionId, timeoutMs);
    if (!verdict.authorized) {
      return err(`authorization denied: ${verdict.reason}. The GitHub call was NOT made.`);
    }

    // Authorized — make the credentialed call. curl honours HTTPS_PROXY + the OneCLI CA; the proxy injects
    // the GitHub token. The stamped header lets the Tier-2 backstop redeem the single-use egress token.
    const STATUS = '<<<STATUS:';
    const curlArgs = [
      '-sS',
      '-X',
      method,
      '-H',
      `X-NanoClaw-Action-Id: ${actionId}`,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'User-Agent: NanoClawAgent/1.0',
      '--max-time',
      '30',
      '-w',
      `\n${STATUS}%{http_code}>>>`,
    ];
    if (hasBody) {
      curlArgs.push('-H', 'Content-Type: application/json', '--data-binary', bodyStr);
    }
    curlArgs.push(`https://${GITHUB_HOST}${path}`);

    try {
      const { stdout } = await execFileAsync('curl', curlArgs, { maxBuffer: 8 * 1024 * 1024 });
      const m = stdout.lastIndexOf(`\n${STATUS}`);
      const status = m >= 0 ? stdout.slice(m + STATUS.length + 1).replace('>>>', '').trim() : '???';
      const respBody = m >= 0 ? stdout.slice(0, m) : stdout;
      const preview = respBody.length > 4000 ? respBody.slice(0, 4000) + '…(truncated)' : respBody;
      return ok(`HTTP ${status} (action ${actionId})\n${preview}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`GitHub call failed after authorization: ${msg}`);
    }
  },
};

registerTools([githubWrite]);
