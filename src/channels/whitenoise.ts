import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { WN_BINARY_PATH, WN_SOCKET_PATH, WN_ACCOUNT_PUBKEY } from '../config.js';
import { reportError, clearAlert } from '../health.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL = 3000;

function createWhiteNoiseAdapter(): ChannelAdapter | null {
  if (!WN_ACCOUNT_PUBKEY) return null;
  if (!fs.existsSync(WN_BINARY_PATH)) {
    log.warn('wn binary not found, skipping WhiteNoise', { path: WN_BINARY_PATH });
    return null;
  }

  let config: ChannelSetup;
  let connected = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeenMessageIds = new Map<string, string>();
  let outgoingQueue: Array<{ platformId: string; text: string }> = [];
  let consecutiveErrors = 0;

  async function runWn(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(WN_BINARY_PATH, [
      '--json',
      '--socket',
      WN_SOCKET_PATH,
      '--account',
      WN_ACCOUNT_PUBKEY,
      ...args,
    ]);
    return stdout;
  }

  async function pollAllGroups(): Promise<void> {
    const wnConversations = config.conversations.filter(
      (c) => true, // all conversations belong to this adapter
    );
    if (wnConversations.length === 0) return;

    for (const conv of wnConversations) {
      try {
        await pollGroup(conv.platformId);
        consecutiveErrors = 0;
        clearAlert('whitenoise-disconnect');
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          reportError('whitenoise-disconnect', `White Noise polling failed ${consecutiveErrors} times: ${err}`);
        }
        log.warn('WN poll failed for group', { err, platformId: conv.platformId });
      }
    }
  }

  async function pollGroup(platformId: string): Promise<void> {
    const stdout = await runWn(['messages', 'list', platformId]);
    let parsed: { result?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return;
    }

    const messages = parsed.result;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return;

    const lastSeenId = lastSeenMessageIds.get(platformId);

    if (!lastSeenId) {
      const latest = messages[messages.length - 1];
      if (latest?.id) lastSeenMessageIds.set(platformId, latest.id as string);
      log.info('WN: initial poll, recording last message ID', { platformId, messageCount: messages.length });
      return;
    }

    const lastSeenIdx = messages.findIndex((m) => m.id === lastSeenId);
    const newMessages = lastSeenIdx >= 0 ? messages.slice(lastSeenIdx + 1) : [];
    if (newMessages.length === 0) return;

    const newest = newMessages[newMessages.length - 1];
    if (newest?.id) lastSeenMessageIds.set(platformId, newest.id as string);

    for (const msg of newMessages) {
      const authorPubkey = msg.author as string;
      const content = (msg.content as string) || '';
      const displayName = (msg.display_name as string) || authorPubkey?.slice(0, 12);
      const createdAt = msg.created_at as number;
      const msgId = msg.id as string;
      const isFromMe = authorPubkey === WN_ACCOUNT_PUBKEY;

      if (isFromMe) continue;

      const timestamp = createdAt ? new Date(createdAt * 1000).toISOString() : new Date().toISOString();
      config.onMetadata(platformId, displayName, true);

      let fullContent = content;
      const mediaAttachments = msg.media_attachments as Array<Record<string, unknown>> | undefined;
      if (mediaAttachments && mediaAttachments.length > 0) {
        for (const attachment of mediaAttachments) {
          const mimeType = (attachment.mime_type as string) || '';
          if (!mimeType.startsWith('image/')) continue;
          const originalHashArr = attachment.original_file_hash as number[] | undefined;
          if (!originalHashArr) continue;
          const fileHash = originalHashArr.map((b: number) => b.toString(16).padStart(2, '0')).join('');
          try {
            const downloadResult = await runWn(['media', 'download', platformId, fileHash]);
            const dl = JSON.parse(downloadResult);
            const filePath = dl?.result?.file_path as string;
            if (filePath) {
              const filename = filePath.split('/').pop();
              fullContent += `\n[Image: /run/whitenoise/media_cache/${filename}]`;
              log.info('WN: downloaded media attachment', { platformId, fileHash });
            }
          } catch (err) {
            log.warn('WN: failed to download media attachment', { err, platformId, fileHash });
          }
        }
      }

      if (!fullContent) continue;

      log.info('WN: new message received', { platformId, sender: displayName, msgId });

      const inbound: InboundMessage = {
        id: `wn-${msgId}`,
        kind: 'chat',
        content: {
          text: fullContent,
          sender: authorPubkey,
          senderId: `whitenoise:${authorPubkey}`,
          senderName: displayName,
        },
        timestamp,
      };
      void config.onInbound(platformId, null, inbound);
    }
  }

  async function flushOutgoingQueue(): Promise<void> {
    while (outgoingQueue.length > 0 && connected) {
      const msg = outgoingQueue.shift()!;
      try {
        await runWn(['messages', 'send', msg.platformId, msg.text]);
      } catch (err) {
        log.error('Failed to flush WN queued message', { err, platformId: msg.platformId });
      }
    }
  }

  const adapter: ChannelAdapter = {
    name: 'WhiteNoise',
    channelType: 'whitenoise',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      config = cfg;
      try {
        await runWn(['accounts', 'list']);
      } catch (err) {
        throw new Error(`Cannot connect to wnd: ${err}`);
      }
      connected = true;
      consecutiveErrors = 0;
      clearAlert('whitenoise-disconnect');
      log.info('White Noise channel connected (polling mode)');

      flushOutgoingQueue().catch((err) => log.error('Failed to flush WN outgoing queue', { err }));

      pollTimer = setInterval(() => {
        pollAllGroups().catch((err) => log.error('WN poll error', { err }));
      }, POLL_INTERVAL);
    },

    async teardown(): Promise<void> {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      // Handle reactions
      if (message.kind === 'reaction') {
        const rc = message.content as { emoji?: string; messageId?: string } | undefined;
        if (rc?.emoji && rc?.messageId) {
          const rawId = rc.messageId.startsWith('wn-') ? rc.messageId.slice(3) : rc.messageId;
          try {
            await runWn(['messages', 'react', platformId, rawId, rc.emoji]);
            log.info('WN reaction sent', { platformId, emoji: rc.emoji });
          } catch (err) {
            log.warn('Failed to send WN reaction', { err, platformId });
          }
        }
        return undefined;
      }

      const content = message.content as Record<string, unknown> | string | undefined;
      let text: string | undefined;
      if (typeof content === 'string') text = content;
      else if (content && typeof content.text === 'string') text = content.text;

      if (!text && !message.files?.length) return undefined;

      if (!connected) {
        if (text) outgoingQueue.push({ platformId, text });
        return undefined;
      }

      if (text) {
        try {
          await runWn(['messages', 'send', platformId, text]);
          log.info('White Noise message sent', { platformId, textLen: text.length });
        } catch (err) {
          log.error('Failed to send WN message', { err, platformId });
        }
      }

      // Handle file attachments
      if (message.files?.length) {
        for (const file of message.files) {
          const tmpPath = path.join(os.tmpdir(), `wn-attach-${Date.now()}-${file.filename}`);
          fs.writeFileSync(tmpPath, file.data);
          try {
            await runWn(['media', 'upload', platformId, tmpPath, '--send']);
            log.info('White Noise image sent', { platformId, filename: file.filename });
          } catch (err) {
            log.error('Failed to send WN image', { err, platformId });
          } finally {
            fs.unlink(tmpPath, () => {});
          }
        }
      }

      return undefined;
    },
  };

  return adapter;
}

const registration: ChannelRegistration = {
  factory: createWhiteNoiseAdapter,
  containerConfig: {
    mounts: [
      {
        hostPath: path.join(os.homedir(), '.local', 'share', 'whitenoise-cli', 'release', 'wnd.sock'),
        containerPath: '/run/whitenoise/wnd.sock',
        readonly: false,
      },
      {
        hostPath: path.join(os.homedir(), '.local', 'share', 'whitenoise-cli', 'release', 'media_cache'),
        containerPath: '/run/whitenoise/media_cache',
        readonly: true,
      },
      {
        hostPath: path.join(os.homedir(), 'whitenoise-rs', 'target', 'release', 'wn'),
        containerPath: '/usr/local/bin/wn',
        readonly: true,
      },
      {
        hostPath: path.join(os.homedir(), 'whitenoise-rs', 'target', 'release', 'wnd'),
        containerPath: '/usr/local/bin/wnd',
        readonly: true,
      },
    ],
  },
};

registerChannelAdapter('whitenoise', registration);
