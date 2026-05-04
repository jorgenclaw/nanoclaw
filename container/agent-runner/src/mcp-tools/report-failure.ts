/**
 * MCP tool: report_failure.
 *
 * Escape hatch for when the agent cannot complete the user's request and
 * would otherwise produce only `<internal>...</internal>` output (which
 * never reaches the user). Smaller models (gemma4:31b, llama4:scout) are
 * prone to this silent-quit failure mode — they decide they're stuck and
 * stop talking instead of telling the user.
 *
 * Calling this tool writes a `⚠️` failure message directly to the session's
 * originating channel, so the user always learns *why* a turn produced no
 * answer instead of just receiving silence.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

registerTools([
  {
    tool: {
      name: 'report_failure',
      description:
        'Tell the user you cannot complete this turn, and why. Call this whenever you have hit an obstacle that prevents you from finishing the user\'s request — read-only filesystem, missing config, broken tool, ambiguous instruction you can\'t resolve, etc. NEVER stay silent: if you cannot complete the request, either ask the user a question (ask_user_question) or call this. Calling this is always preferable to ending the turn with internal-only output.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          reason: {
            type: 'string',
            description:
              'Short, plain-language explanation of what went wrong and what you tried. Address the user directly. 1–4 sentences. Avoid jargon when possible. Example: "I tried to post to Clawstr but the clawstr-post binary refused to run — `chmod +x` failed because /usr/local/bin is read-only inside my container. I think the binary is already executable; want me to try running it directly?"',
          },
        },
        required: ['reason'],
      },
    },
    async handler(args) {
      const reason = String((args as { reason?: string }).reason ?? '').trim();
      if (!reason) {
        return {
          content: [{ type: 'text' as const, text: 'Error: reason is required' }],
          isError: true,
        };
      }
      const r = getSessionRouting();
      if (!r.channel_type || !r.platform_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: no session routing — cannot deliver failure report to a user.',
            },
          ],
          isError: true,
        };
      }
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: r.platform_id,
        channel_type: r.channel_type,
        thread_id: r.thread_id,
        content: JSON.stringify({ text: `⚠️ ${reason}` }),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Failure report sent to user. Conclude this turn — no further <message to=...> block needed.',
          },
        ],
      };
    },
  },
]);
