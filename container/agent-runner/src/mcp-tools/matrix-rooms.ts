/**
 * Matrix room MCP tool: create_matrix_room.
 *
 * Asks the host for a new private Matrix room. The host decides — every
 * request is held for the owner's approval (src/modules/matrix-rooms). This
 * tool only writes the outbound request; the container is untrusted and is
 * never relied on to authorize itself.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createMatrixRoom: McpToolDefinition = {
  tool: {
    name: 'create_matrix_room',
    description:
      'Ask for a new private Matrix room (Scott must approve every request). The owner is invited by default. You are told when the room exists or when the request is refused. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Room name as it will appear in Element X (max 80 characters)' },
        topic: { type: 'string', description: 'Optional one-line description (max 250 characters)' },
        invite: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional Matrix user ids to invite, e.g. "@scott:matrix.jorgenclaw.ai". Leave out to invite the owner. Do not invite anyone else unless Scott told you to.',
        },
        agent: {
          type: 'string',
          description:
            'Optional. The name of a sub-agent you created (the name you use with send_message) to put in the room. Leave out to make the room yours.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return err('name is required');
    if (args.invite != null && (!Array.isArray(args.invite) || !args.invite.every((v) => typeof v === 'string'))) {
      return err('invite must be a list of Matrix user ids');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_matrix_room',
        requestId,
        name,
        topic: typeof args.topic === 'string' && args.topic.trim() ? args.topic.trim() : null,
        invite: Array.isArray(args.invite) ? args.invite : null,
        agent: typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : null,
      }),
    });

    log(`create_matrix_room: ${requestId} → "${name}"`);
    return ok(`Asked for the room "${name}". Scott has to approve it; you will be told when it exists or if it is refused.`);
  },
};

registerTools([createMatrixRoom]);
