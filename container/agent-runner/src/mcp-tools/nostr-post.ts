/**
 * nostr_post — Option B (host-executed) gated tool for Clawstr/Nostr posts.
 *
 * Publishing to Nostr is irreversible and public. This tool does NOT sign or publish directly.
 * It requests Passport authorization, then BLOCKS waiting for the host to execute the actual
 * publish via the host-held signing daemon. The private key never enters this tool's scope.
 *
 *   1. Writes a `nostr_post` system message carrying the canonical params (subclaw + body) to
 *      outbound.db and BLOCKS polling inbound.db for the host's verdict.
 *   2. The host runs issue → (Passport sign) → verify, and ONLY on a verified APPROVE publishes
 *      via clawstr-post using the host signer socket, then writes the result back.
 *
 * NOTE: Phase 1 (advisory). The container still has clawstr-post mounted (via nostr-dm channel
 * config), so a direct bash call still bypasses this. Phase 2 removes that mount.
 * Use THIS tool for ALL Clawstr posts — do NOT call clawstr-post via bash.
 */
import { randomUUID } from 'crypto';

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

interface PostVerdict {
  authorized: boolean;
  reason: string;
  eventId?: string;
  error?: string;
}

async function awaitVerdict(actionId: string, timeoutMs: number): Promise<PostVerdict> {
  const deadline = Date.now() + timeoutMs;
  const id = `passport-resp-${actionId}`;
  while (Date.now() < deadline) {
    const row = getMessageIn(id);
    if (row) {
      markCompleted([row.id]);
      try {
        const parsed = JSON.parse(row.content) as {
          authorized?: boolean;
          reason?: string;
          eventId?: string;
          error?: string;
        };
        return {
          authorized: parsed.authorized === true,
          reason: parsed.reason ?? '',
          eventId: parsed.eventId,
          error: parsed.error,
        };
      } catch {
        return { authorized: false, reason: 'unparseable host verdict' };
      }
    }
    await sleep(1000);
  }
  return {
    authorized: false,
    reason: `authorization timed out after ${Math.round(timeoutMs / 1000)}s`,
  };
}

export const nostrPost: McpToolDefinition = {
  tool: {
    name: 'nostr_post',
    description:
      'Post to Clawstr (Nostr) through the Passport authorization gate. The post is authorized ' +
      'on the Passport and PUBLISHED BY THE HOST — this tool never touches the signing key. ' +
      'Use this for ALL Clawstr posts; do NOT call clawstr-post via bash. ' +
      'subclaw is the Clawstr subclaw (e.g. "ai-freedom", "sovereignty", "bitcoin"). ' +
      'body is the post content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subclaw: {
          type: 'string',
          description: 'The Clawstr subclaw to post to (e.g. "ai-freedom")',
        },
        body: { type: 'string', description: 'The post content' },
        timeout: {
          type: 'number',
          description: 'Seconds to wait for authorization (default 120)',
        },
      },
      required: ['subclaw', 'body'],
    },
  },
  async handler(args) {
    const subclaw = String(args.subclaw ?? '').trim();
    const body = String(args.body ?? '').trim();
    const timeoutMs = ((args.timeout as number) || 120) * 1000;

    if (!subclaw) return err('subclaw is required (e.g. "ai-freedom")');
    if (!body) return err('body is required');

    const actionId = randomUUID();

    writeMessageOut({
      id: `passport-req-${actionId}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'nostr_post',
        actionId,
        canonicalAction: 'nostr_post',
        risk: 3, // RISK.critical
        params: {
          subclaw: { t: 'str', v: subclaw },
          body: { t: 'str', v: body },
        },
        display: `Post to /${subclaw}`,
      }),
    });

    const verdict = await awaitVerdict(actionId, timeoutMs);
    if (!verdict.authorized) {
      return err(`authorization denied: ${verdict.reason}. Nothing was posted.`);
    }
    return ok(
      `Posted to /${subclaw} (action ${actionId}).` +
        (verdict.eventId ? `\nevent: ${verdict.eventId}` : ''),
    );
  },
};

registerTools([nostrPost]);
