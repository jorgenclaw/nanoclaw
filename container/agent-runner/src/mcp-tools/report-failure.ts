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
        'Tell the user you cannot complete this turn, and why. ' +
        '**MANDATORY PRECONDITION: you must have actually attempted the underlying work in this same turn — at least one real tool call against the relevant subsystem — and observed a concrete failure.** ' +
        'Never call this preemptively or based on prior-turn context. If the user asks you to read mail, you must first call the proton mail-list/search/read tool and see the actual error before reporting Bridge as down. If the user asks you to post to Clawstr, you must first run clawstr-post and observe the exit code. ' +
        'Acceptable reasons to call this AFTER attempting: read-only filesystem error, missing config file, broken tool returned a non-recoverable error, ambiguous instruction you can\'t resolve. ' +
        'Calling this without first attempting is a contract violation that wastes the user\'s trust — the typical failure mode is fabricating a plausible-sounding but fictitious error from stale context. ' +
        'NEVER stay silent: if you genuinely cannot complete the request after a real attempt, either ask the user a question (ask_user_question) or call this. Calling this (after a real attempt) is preferable to ending the turn with internal-only output.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          reason: {
            type: 'string',
            description:
              'Short, plain-language explanation of what went wrong and what you actually tried. Must reference the specific tool/command you ran and the literal error you observed. Address the user directly. 1–4 sentences. Avoid jargon when possible. Example: "I called the proton mail_list_folders tool and it returned EAGAIN trying to reach 127.0.0.1:1143 — looks like Bridge is unreachable from inside the container. Want me to file a quad task asking Quad to check Bridge?"',
          },
          attempted: {
            type: 'string',
            description: 'REQUIRED. The exact tool name(s) you called BEFORE deciding to give up, comma-separated. E.g. "mail_list_folders" or "bash:clawstr-post post" or "weather". If you did not attempt the work yet, do not call this tool — make the actual attempt first.',
          },
        },
        required: ['reason', 'attempted'],
      },
    },
    async handler(args) {
      const reason = String((args as { reason?: string }).reason ?? '').trim();
      const attempted = String((args as { attempted?: string }).attempted ?? '').trim();
      if (!reason) {
        return {
          content: [{ type: 'text' as const, text: 'Error: reason is required' }],
          isError: true,
        };
      }
      if (!attempted) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: `attempted` is required and must name the actual tool(s) you called before giving up. Re-attempt the work with the correct tool, observe the real error, then call report_failure with that observation. Do not fabricate.',
            },
          ],
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
      // Log the attempted-tool annotation so the host can audit hallucinated
      // failures. This ends up in container stdout → docker logs.
      console.error(`[report_failure] attempted=${attempted} reason=${reason.slice(0, 200)}`);
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
