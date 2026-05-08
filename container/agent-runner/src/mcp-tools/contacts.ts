/**
 * Contact registration MCP tool.
 *
 * Lets the agent approve new contacts by writing a system action.
 * The host delivery handler creates the user + agent group membership.
 */
import { getSessionRouting } from '../db/session-routing.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';

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

function routing() {
  return getSessionRouting() ?? { channel_type: null, platform_id: null, thread_id: null };
}

registerTools([
  {
    tool: {
      name: 'register_contact',
      description:
        'Register a new contact so their messages are processed. ' +
        'Use when the admin asks you to approve a contact. ' +
        'Provide the channel type (signal, nostr-dm, etc.), the platform ID ' +
        '(UUID for Signal, hex pubkey for Nostr), a display name, and the ' +
        'folder name for their agent group (lowercase, hyphens only).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channelType: { type: 'string', description: 'Channel type: signal, nostr-dm, whitenoise' },
          platformId: { type: 'string', description: 'Platform identifier (Signal UUID, Nostr hex pubkey, etc.)' },
          displayName: { type: 'string', description: 'Contact display name' },
          folder: { type: 'string', description: 'Agent group folder name (lowercase, hyphens only, e.g. "john-doe")' },
          requiresTrigger: { type: 'boolean', description: 'Whether messages need @trigger prefix (default: false for DMs)' },
        },
        required: ['channelType', 'platformId', 'displayName', 'folder'],
      },
    },
    async handler(args) {
      const channelType = args.channelType as string;
      const platformId = args.platformId as string;
      const displayName = args.displayName as string;
      const folder = args.folder as string;
      const requiresTrigger = (args.requiresTrigger as boolean) ?? false;

      if (!channelType || !platformId || !displayName || !folder) {
        return err('channelType, platformId, displayName, and folder are all required');
      }
      if (!/^[a-z0-9-]+$/.test(folder)) {
        return err('folder must be lowercase letters, numbers, and hyphens only');
      }

      const id = generateId();
      const r = routing();

      writeMessageOut({
        id,
        kind: 'system',
        platform_id: r.platform_id,
        channel_type: r.channel_type,
        thread_id: r.thread_id,
        content: JSON.stringify({
          action: 'register_contact',
          channelType,
          platformId,
          displayName,
          folder,
          requiresTrigger,
        }),
      });

      log(`register_contact: ${displayName} (${channelType}:${platformId}) → folder ${folder}`);
      return ok(`Contact registration requested for ${displayName}. They will be able to message after the host processes this.`);
    },
  },
]);
