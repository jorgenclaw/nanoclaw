import { execSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { ASSISTANT_NAME, SIGNAL_CLI_TCP_HOST, SIGNAL_CLI_TCP_PORT, SIGNAL_PHONE_NUMBER } from '../config.js';
import { reportError, clearAlert } from '../health.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: number;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  id?: number;
}

interface SignalAttachment {
  contentType?: string;
  id?: string;
  localPath?: string;
  voiceNote?: boolean;
  filename?: string;
  size?: number;
}

interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
  name?: string;
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    mentions?: SignalMention[];
    attachments?: SignalAttachment[];
    groupInfo?: { groupId?: string; type?: string };
    groupV2?: { id?: string };
    groupContext?: { title?: string; groupId?: string };
    quote?: {
      id?: number;
      author?: string;
      authorNumber?: string;
      authorName?: string;
      text?: string;
    };
  };
  syncMessage?: {
    sentMessage?: {
      message?: string;
      destination?: string;
      destinationNumber?: string;
      groupInfo?: { groupId?: string };
      groupV2?: { id?: string };
    };
  };
}

/**
 * Split long outbound messages at newline boundaries near the `limit` mark.
 * Signal's server rejects individual messages above a size cap (empirically
 * ~4 KB); without chunking, anything longer fails silently.
 */
function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  start: number;
  length: number;
}

interface StyledText {
  text: string;
  textStyles: SignalTextStyle[];
}

/**
 * Convert markdown-ish input into Signal's offset-based `textStyle` ranges so
 * `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, and `||spoiler||`
 * render as actual Signal styling instead of leaking markup characters.
 *
 * Walks recursively: at each level find the leftmost matching pattern,
 * descend into its captured inner (so nested styles like `**bold `code`**`
 * compose correctly), then continue past the match. Style offsets are
 * recorded against the *output* text length as it's built.
 */
function parseSignalStyles(input: string): StyledText {
  const styles: SignalTextStyle[] = [];

  const patterns: Array<{ regex: RegExp; style: SignalTextStyle['style'] }> = [
    { regex: /```([\s\S]+?)```/, style: 'MONOSPACE' },
    { regex: /`([^`]+)`/, style: 'MONOSPACE' },
    { regex: /\*\*([^]+?)\*\*/, style: 'BOLD' },
    { regex: /~~([^]+?)~~/, style: 'STRIKETHROUGH' },
    { regex: /\|\|([^]+?)\|\|/, style: 'SPOILER' },
    { regex: /\*([^*\s][^*]*?)\*/, style: 'ITALIC' },
    { regex: /_([^_\s][^_]*?)_/, style: 'ITALIC' },
  ];

  function walk(segment: string, outputBase: number): string {
    let earliest: { start: number; match: RegExpExecArray; style: SignalTextStyle['style'] } | null = null;
    for (const { regex, style } of patterns) {
      const m = regex.exec(segment);
      if (!m) continue;
      if (earliest === null || m.index < earliest.start) {
        earliest = { start: m.index, match: m, style };
      }
    }
    if (!earliest) return segment;

    const before = segment.slice(0, earliest.start);
    const fullMatch = earliest.match[0];
    const inner = earliest.match[1];
    const afterStart = earliest.start + fullMatch.length;
    const after = segment.slice(afterStart);

    const innerOut = walk(inner, outputBase + before.length);
    styles.push({
      style: earliest.style,
      start: outputBase + before.length,
      length: innerOut.length,
    });
    const afterOut = walk(after, outputBase + before.length + innerOut.length);

    return before + innerOut + afterOut;
  }

  const text = walk(input, 0);
  return { text, textStyles: styles };
}

function resolveMentions(text: string, mentions?: SignalMention[]): string {
  if (!mentions || mentions.length === 0) return text;
  const sorted = [...mentions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let mentionIdx = 0;
  let result = '';
  for (const ch of text) {
    if (ch === '\uFFFC' && mentionIdx < sorted.length) {
      const m = sorted[mentionIdx++]!;
      result += `@${m.name || m.number || m.uuid || 'unknown'}`;
    } else {
      result += ch;
    }
  }
  return result;
}

function createSignalAdapter(): ChannelAdapter | null {
  if (!SIGNAL_PHONE_NUMBER) return null;

  let config: ChannelSetup;
  let socket: net.Socket | null = null;
  let connected = false;
  let buffer = '';
  let rpcId = 1;
  let outgoingQueue: Array<{ platformId: string; text: string; attachments?: string[] }> = [];
  let flushing = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastGroupDataMessage = Date.now();
  let lastSignalCliRestart = Date.now();
  let lastReceiveEvent = Date.now();
  // Dedupe ring for `receive` events. signal-cli emits the same envelope
  // through both `params.envelope` (broadcast) and `params.result.envelope`
  // (subscription response) — they arrive as two separate JSON-RPC events
  // with identical envelope content. We track recently-seen envelope keys
  // (timestamp + source) to suppress the second copy.
  const recentEnvelopes = new Set<string>();
  const RECENT_ENVELOPES_CAP = 256;

  const pendingRpc = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  const RPC_TIMEOUT_MS = 60000;

  function sendRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!socket || !connected) return Promise.reject(new Error('Signal not connected'));
    const id = rpcId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params, id };
    socket.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`RPC ${method} (id=${id}) timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      pendingRpc.set(id, { resolve, reject, timeout });
    });
  }

  function sendRpcFireAndForget(method: string, params?: Record<string, unknown>): void {
    sendRpc(method, params).catch((err) => log.warn('RPC fire-and-forget error', { method, err }));
  }

  function sendToSignal(platformId: string, text: string, attachments?: string[]): Promise<unknown> {
    const isGroup = platformId.startsWith('group.');
    const params: Record<string, unknown> = {
      account: SIGNAL_PHONE_NUMBER,
      message: text,
    };
    if (attachments?.length) params.attachment = attachments;
    if (isGroup) {
      params.groupId = platformId.slice('group.'.length);
    } else {
      params.recipient = [platformId];
    }
    return sendRpc('send', params);
  }

  async function flushOutgoingQueue(): Promise<void> {
    if (flushing || outgoingQueue.length === 0) return;
    flushing = true;
    try {
      log.info('Flushing outgoing Signal queue', { count: outgoingQueue.length });
      while (outgoingQueue.length > 0) {
        const item = outgoingQueue.shift()!;
        try {
          await sendToSignal(item.platformId, item.text, item.attachments);
        } catch (err) {
          log.error('Failed to send queued Signal message', { platformId: item.platformId, err });
        }
      }
    } finally {
      flushing = false;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectAttempts++;
    if (reconnectAttempts === 3) {
      reportError('signal-disconnect', `Signal connection lost. Failed to reconnect ${reconnectAttempts} times.`);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log.info('Reconnecting to signal-cli...');
      connectInternal();
    }, 5000);
  }

  async function handleReceiveEvent(obj: JsonRpcMessage): Promise<void> {
    const params = obj.params as
      | { account?: string; envelope?: SignalEnvelope; result?: { envelope?: SignalEnvelope } }
      | undefined;
    const envelope = params?.envelope ?? params?.result?.envelope;
    if (!envelope) return;
    lastReceiveEvent = Date.now();

    // Dedupe by envelope key. signal-cli emits the same envelope through both
    // `params.envelope` (broadcast) and `params.result.envelope` (subscription
    // response), and they arrive as two separate `receive` JSON-RPC events.
    // Without this guard, the same message gets routed twice — first insert
    // succeeds, second fails with `UNIQUE constraint failed: messages_in.id`.
    const dedupeKey = `${envelope.timestamp || 0}_${envelope.source || envelope.sourceNumber || ''}`;
    if (recentEnvelopes.has(dedupeKey)) {
      log.debug('Signal duplicate envelope suppressed', { dedupeKey });
      return;
    }
    recentEnvelopes.add(dedupeKey);
    if (recentEnvelopes.size > RECENT_ENVELOPES_CAP) {
      // FIFO eviction — drop oldest insertion. Set iteration order is insertion
      // order in modern JS, so the first key is the oldest.
      const oldest = recentEnvelopes.values().next().value;
      if (oldest !== undefined) recentEnvelopes.delete(oldest);
    }

    const timestamp = envelope.timestamp ? new Date(envelope.timestamp).toISOString() : new Date().toISOString();

    // Sync messages (sent from another device)
    if (envelope.syncMessage?.sentMessage) {
      const sent = envelope.syncMessage.sentMessage;
      const content = sent.message || '';
      if (!content) return;

      let platformId: string;
      let isGroup: boolean;
      const sentGroupId = sent.groupV2?.id || sent.groupInfo?.groupId;
      if (sentGroupId) {
        platformId = `group.${sentGroupId}`;
        isGroup = true;
      } else {
        const dest = sent.destinationNumber || sent.destination || '';
        if (!dest) return;
        platformId = dest;
        isGroup = false;
      }

      config.onMetadata(platformId, undefined, isGroup);
      return;
    }

    // Data messages from others
    const dataMsg = envelope.dataMessage;
    if (!dataMsg) return;

    const audioAttachment = dataMsg.attachments?.find((a) => a.contentType?.startsWith('audio/') && a.id);
    const imageAttachments = dataMsg.attachments?.filter((a) => a.contentType?.startsWith('image/') && a.id) ?? [];
    if (!dataMsg.message && !audioAttachment && imageAttachments.length === 0) return;

    const senderId = envelope.source || envelope.sourceNumber || '';
    const senderPhone = envelope.sourceNumber || envelope.source || '';
    const senderName = envelope.sourceName || senderPhone;

    // Build the plain-text portion: caption text + image markers (images
    // are passed as inline text markers so the agent can Read the file).
    let textContent = dataMsg.message ? resolveMentions(dataMsg.message, dataMsg.mentions) : '';
    for (const img of imageAttachments) {
      const imageLine = `[Image: /workspace/attachments/${img.id}]`;
      textContent = textContent ? `${textContent}\n${imageLine}` : imageLine;
    }

    // Audio is transcribed inside the container, sovereignty-by-default.
    // We surface it as an attachment manifest entry — auto-transcribe.ts
    // (container side) finds it via `parsed.attachments`, runs whisper-cli
    // locally, and replaces the text with `[Voice (local-whisper): "..."]`
    // before the formatter renders it for the agent.
    const audioAttachments: Array<{ name: string; mimeType: string; localPath: string }> = [];
    if (audioAttachment) {
      audioAttachments.push({
        name: audioAttachment.id!,
        mimeType: audioAttachment.contentType || 'audio/aac',
        localPath: `/workspace/attachments/${audioAttachment.id}`,
      });
    }

    let platformId: string;
    let isGroup: boolean;
    let groupName: string | undefined;

    const groupId = dataMsg.groupV2?.id || dataMsg.groupInfo?.groupId;
    if (groupId) {
      platformId = `group.${groupId}`;
      isGroup = true;
      groupName = dataMsg.groupContext?.title;
      lastGroupDataMessage = Date.now();
    } else {
      platformId = senderId;
      isGroup = false;
    }

    const chatName = isGroup ? groupName : senderName || undefined;
    config.onMetadata(platformId, chatName, isGroup);

    const quote = dataMsg.quote;
    const inbound: InboundMessage = {
      id: `${envelope.timestamp || Date.now()}`,
      kind: 'chat',
      content: {
        text: textContent,
        sender: senderPhone,
        senderId: `signal:${senderId}`,
        senderName,
        replyTo: quote
          ? {
              text: quote.text || '',
              sender: quote.authorName || quote.authorNumber || quote.author || 'Unknown',
            }
          : undefined,
        attachments: audioAttachments.length > 0 ? audioAttachments : undefined,
      },
      timestamp,
    };

    void config.onInbound(platformId, null, inbound);
  }

  function connectInternal(onFirstOpen?: () => void): void {
    const sock = new net.Socket();
    socket = sock;

    sock.on('connect', () => {
      connected = true;
      reconnectAttempts = 0;
      clearAlert('signal-disconnect');
      log.info('Connected to signal-cli', { host: SIGNAL_CLI_TCP_HOST, port: SIGNAL_CLI_TCP_PORT });

      sendRpcFireAndForget('subscribeReceive', { account: SIGNAL_PHONE_NUMBER });
      flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
      }
    });

    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as JsonRpcMessage;
          if (obj.id != null && pendingRpc.has(obj.id)) {
            const pending = pendingRpc.get(obj.id)!;
            pendingRpc.delete(obj.id);
            clearTimeout(pending.timeout);
            if (obj.error) {
              pending.reject(new Error(`signal-cli RPC error: ${JSON.stringify(obj.error)}`));
            } else {
              pending.resolve(obj.result);
            }
          } else if (obj.method === 'receive') {
            handleReceiveEvent(obj).catch((err) => log.error('Error handling receive event', { err }));
          }
        } catch (err) {
          log.warn('Failed to parse signal-cli message', { err, line: trimmed.slice(0, 100) });
        }
      }
    });

    sock.on('close', () => {
      connected = false;
      for (const [id, pending] of pendingRpc) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Signal socket closed'));
      }
      pendingRpc.clear();
      log.info('signal-cli socket closed, reconnecting in 5s', { queuedMessages: outgoingQueue.length });
      scheduleReconnect();
    });

    sock.on('error', (err) => {
      log.error('signal-cli socket error', { err });
    });

    sock.connect(SIGNAL_CLI_TCP_PORT, SIGNAL_CLI_TCP_HOST);
  }

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(
      () => {
        const now = Date.now();

        const minSinceReceive = (now - lastReceiveEvent) / (1000 * 60);
        const minSinceConnect = (now - lastSignalCliRestart) / (1000 * 60);
        if (connected && minSinceConnect >= 10 && minSinceReceive >= 10) {
          log.warn('Watchdog: no receive events for 10+ min — reconnecting', {
            minSinceReceive: minSinceReceive.toFixed(1),
          });
          lastReceiveEvent = now;
          socket?.destroy();
          return;
        }

        const hoursSinceGroupMsg = (now - lastGroupDataMessage) / (1000 * 60 * 60);
        const hoursSinceRestart = (now - lastSignalCliRestart) / (1000 * 60 * 60);
        if (hoursSinceGroupMsg >= 6 || hoursSinceRestart >= 8) {
          log.info('Watchdog: restarting signal-cli', {
            hoursSinceGroupMsg: hoursSinceGroupMsg.toFixed(1),
            hoursSinceRestart: hoursSinceRestart.toFixed(1),
          });
          try {
            lastSignalCliRestart = Date.now();
            lastGroupDataMessage = Date.now();
            execSync('systemctl --user restart signal-cli', { timeout: 15000 });
            log.info('signal-cli restarted by watchdog');
          } catch (err) {
            log.error('Watchdog failed to restart signal-cli', { err });
            reportError('signal-cli-watchdog', 'Failed to restart signal-cli via watchdog');
          }
        }
      },
      5 * 60 * 1000,
    );
  }

  const adapter: ChannelAdapter = {
    name: 'Signal',
    channelType: 'signal',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      config = cfg;
      await new Promise<void>((resolve) => {
        connectInternal(resolve);
      });
      startWatchdog();
    },

    async teardown(): Promise<void> {
      connected = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      socket?.destroy();
      socket = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown> | string | undefined;

      // Handle reaction messages
      if (message.kind === 'reaction') {
        const rc = content as { emoji?: string; messageId?: string; targetAuthor?: string } | undefined;
        if (rc?.emoji && rc?.messageId) {
          const targetTimestamp = parseInt(rc.messageId, 10);
          if (!isNaN(targetTimestamp)) {
            const isGroup = platformId.startsWith('group.');
            const params: Record<string, unknown> = {
              account: SIGNAL_PHONE_NUMBER,
              emoji: rc.emoji,
              targetAuthor: rc.targetAuthor || SIGNAL_PHONE_NUMBER,
              targetTimestamp,
            };
            if (isGroup) {
              params.groupId = platformId.slice('group.'.length);
            } else {
              params.recipient = [platformId];
            }
            await sendRpc('sendReaction', params);
            log.info('Signal reaction sent', { platformId, emoji: rc.emoji, messageId: rc.messageId });
          }
        }
        return undefined;
      }

      // Extract text
      let text: string | undefined;
      if (typeof content === 'string') {
        text = content;
      } else if (content && typeof content.text === 'string') {
        text = content.text;
      }

      // Handle file attachments
      const tmpFiles: string[] = [];
      if (message.files?.length) {
        for (const file of message.files) {
          const tmpPath = path.join(os.tmpdir(), `signal-attach-${Date.now()}-${file.filename}`);
          fs.writeFileSync(tmpPath, file.data);
          tmpFiles.push(tmpPath);
        }
      }

      if (!text && tmpFiles.length === 0) return undefined;

      if (!connected) {
        outgoingQueue.push({ platformId, text: text || '', attachments: tmpFiles.length > 0 ? tmpFiles : undefined });
        log.info('Signal disconnected, message queued', { platformId, queueSize: outgoingQueue.length });
        return undefined;
      }

      const isGroup = platformId.startsWith('group.');
      const groupId = isGroup ? platformId.slice('group.'.length) : undefined;

      // Signal rejects single messages above ~4 KB. Chunk on newline
      // boundaries so multi-paragraph replies arrive intact. Attachments
      // ride with the first chunk only; subsequent chunks are text-only.
      const MAX_CHUNK = 4000;
      const textChunks = text && text.length > MAX_CHUNK ? chunkText(text, MAX_CHUNK) : text ? [text] : [''];

      let lastTimestamp: number | undefined;
      try {
        for (let i = 0; i < textChunks.length; i++) {
          const chunk = textChunks[i]!;
          const { text: plainText, textStyles } = parseSignalStyles(chunk);
          const params: Record<string, unknown> = {
            account: SIGNAL_PHONE_NUMBER,
            message: plainText,
          };
          if (textStyles.length > 0) {
            params.textStyle = textStyles.map((s) => `${s.start}:${s.length}:${s.style}`);
          }
          if (i === 0 && tmpFiles.length > 0) params.attachment = tmpFiles;
          if (isGroup) params.groupId = groupId;
          else params.recipient = [platformId];

          let result: { timestamp?: number } | undefined;
          try {
            result = (await sendRpc('send', params)) as { timestamp?: number } | undefined;
          } catch (styledErr) {
            // Fall back to raw markup if signal-cli rejects textStyle (older
            // daemon versions or group-policy quirks). Preserves delivery
            // at the cost of visible `**`/`` ` `` etc.
            if (textStyles.length > 0) {
              log.debug('Signal textStyle rejected, retrying with raw markup', { platformId });
              delete params.textStyle;
              params.message = chunk;
              result = (await sendRpc('send', params)) as { timestamp?: number } | undefined;
            } else {
              throw styledErr;
            }
          }
          if (result?.timestamp) lastTimestamp = result.timestamp;
        }
        log.info('Signal message sent', {
          platformId,
          textLen: text?.length ?? 0,
          chunks: textChunks.length,
          timestamp: lastTimestamp,
        });

        // Clean up temp files after signal-cli confirms send
        if (tmpFiles.length > 0) {
          for (const f of tmpFiles) fs.unlink(f, () => {});
        }

        return lastTimestamp ? String(lastTimestamp) : undefined;
      } catch (err) {
        log.error('Signal send failed', { platformId, err });
        // Clean up temp files on failure too
        if (tmpFiles.length > 0) {
          for (const f of tmpFiles) fs.unlink(f, () => {});
        }
        throw err;
      }
    },
  };

  return adapter;
}

const registration: ChannelRegistration = {
  factory: createSignalAdapter,
  containerConfig: {
    mounts: [
      {
        hostPath: path.join(os.homedir(), '.local', 'share', 'signal-cli', 'attachments'),
        containerPath: '/workspace/attachments',
        readonly: true,
      },
    ],
  },
};

registerChannelAdapter('signal', registration);
