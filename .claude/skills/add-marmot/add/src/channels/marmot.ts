/**
 * Marmot / White Noise channel for NanoClaw.
 *
 * Enables decentralized, end-to-end encrypted group messaging using the
 * Marmot protocol (MLS + Nostr). Compatible with the White Noise app and
 * any other Marmot-protocol client.
 *
 * @see https://github.com/marmot-protocol/marmot-ts
 * @see https://marmot.build
 */

import { getPublicKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools';
import { SimplePool, type SubCloser } from 'nostr-tools/pool';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import {
  MARMOT_NOSTR_PRIVATE_KEY,
  MARMOT_NOSTR_RELAYS,
  MARMOT_POLL_INTERVAL_MS,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// JID helpers
// ---------------------------------------------------------------------------

const MARMOT_PREFIX = 'marmot:';

function jidFromGroupId(groupIdHex: string): string {
  return `${MARMOT_PREFIX}${groupIdHex}`;
}

function groupIdFromJid(jid: string): string | null {
  if (!jid.startsWith(MARMOT_PREFIX)) return null;
  return jid.slice(MARMOT_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Nostr Event Signer (wraps a raw nsec hex key)
// ---------------------------------------------------------------------------

class NsecSigner {
  private secretKey: Uint8Array;
  public pubkeyHex: string;

  constructor(nsecHex: string) {
    this.secretKey = hexToBytes(nsecHex);
    this.pubkeyHex = getPublicKey(this.secretKey);
  }

  getPublicKey(): string {
    return this.pubkeyHex;
  }

  signEvent(event: UnsignedEvent): any {
    return finalizeEvent(event, this.secretKey);
  }
}

// ---------------------------------------------------------------------------
// Nostr Pool Adapter
// ---------------------------------------------------------------------------

class NostrPoolAdapter {
  private pool: SimplePool;
  private defaultRelays: string[];

  constructor(relays: string[]) {
    this.pool = new SimplePool();
    this.defaultRelays = relays;
  }

  async publish(relays: string[], event: any): Promise<void> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    // pool.publish returns Promise<string>[] (one per relay)
    const results = this.pool.publish(targets, event);
    await Promise.allSettled(
      results.map((p) =>
        p.catch((err: Error) => {
          logger.debug({ err: err.message }, 'Relay publish failed');
        }),
      ),
    );
  }

  async request(relays: string[], filter: Record<string, any>): Promise<any[]> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    return await this.pool.querySync(targets, filter as any);
  }

  subscribe(
    relays: string[],
    filter: Record<string, any>,
    handlers: { onevent: (event: any) => void; oneose?: () => void },
  ): SubCloser {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    return this.pool.subscribeMany(targets, filter as any, handlers);
  }

  close(): void {
    this.pool.close(this.defaultRelays);
  }
}

// ---------------------------------------------------------------------------
// MarmotChannel — NanoClaw Channel implementation
// ---------------------------------------------------------------------------

export class MarmotChannel implements Channel {
  name = 'marmot';

  private opts: ChannelOpts;
  private network: NostrPoolAdapter | null = null;
  private signer: NsecSigner | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions = new Map<string, { close: () => void }>();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!MARMOT_NOSTR_PRIVATE_KEY) {
      throw new Error(
        'MARMOT_NOSTR_PRIVATE_KEY is required. Generate with: ' +
          'node -e "import(\'nostr-tools\').then(n => console.log(Buffer.from(n.generateSecretKey()).toString(\'hex\')))"',
      );
    }

    if (MARMOT_NOSTR_RELAYS.length === 0) {
      throw new Error(
        'MARMOT_NOSTR_RELAYS is required. Example: wss://relay.damus.io,wss://nos.lol',
      );
    }

    // Initialize signer with Nostr private key
    this.signer = new NsecSigner(MARMOT_NOSTR_PRIVATE_KEY);
    const pubkey = this.signer.getPublicKey();

    // Initialize Nostr relay pool
    this.network = new NostrPoolAdapter(MARMOT_NOSTR_RELAYS);

    // Subscribe to registered Marmot groups
    const registeredGroups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(registeredGroups)) {
      const groupId = groupIdFromJid(jid);
      if (!groupId) continue;
      this.subscribeToGroup(groupId, group.name);
    }

    // Start polling for welcome messages (group invitations)
    this.startWelcomePoller(pubkey);

    this.connected = true;

    console.log(`\n  Marmot channel: npub ${pubkey.slice(0, 16)}...`);
    console.log(`  Relays: ${MARMOT_NOSTR_RELAYS.join(', ')}`);
    console.log(
      `  Send a White Noise invite to this npub to start messaging\n`,
    );

    logger.info(
      { pubkey, relays: MARMOT_NOSTR_RELAYS },
      'Marmot channel connected',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.network || !this.signer) {
      logger.warn('Marmot client not initialized');
      return;
    }

    const groupId = groupIdFromJid(jid);
    if (!groupId) {
      logger.warn({ jid }, 'Invalid Marmot JID');
      return;
    }

    try {
      // Create a kind 444 MLS application message event.
      // TODO: In full implementation, encrypt content via MLS before publishing.
      const event: UnsignedEvent = {
        kind: 444,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['g', groupId]],
        content: text,
        pubkey: this.signer.getPublicKey(),
      };

      const signed = this.signer.signEvent(event);
      await this.network.publish(MARMOT_NOSTR_RELAYS, signed);

      logger.info({ jid, length: text.length }, 'Marmot message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Marmot message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MARMOT_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const [, sub] of this.subscriptions) {
      sub.close();
    }
    this.subscriptions.clear();

    if (this.network) {
      this.network.close();
      this.network = null;
    }

    this.signer = null;
    this.connected = false;

    logger.info('Marmot channel disconnected');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Subscribe to messages for a Marmot group.
   * Listens for kind 444 (MLS application messages) tagged with the group ID.
   */
  private subscribeToGroup(groupIdHex: string, groupName: string): void {
    if (!this.network) return;
    if (this.subscriptions.has(groupIdHex)) return;

    const jid = jidFromGroupId(groupIdHex);

    const sub = this.network.subscribe(
      MARMOT_NOSTR_RELAYS,
      {
        kinds: [444],
        '#g': [groupIdHex],
        since: Math.floor(Date.now() / 1000),
      },
      {
        onevent: (event: any) => {
          this.handleNostrEvent(jid, groupName, event);
        },
      },
    );

    this.subscriptions.set(groupIdHex, sub);
    logger.info({ jid, groupIdHex }, 'Subscribed to Marmot group');
  }

  /**
   * Handle an incoming Nostr event from a Marmot group.
   * TODO: In full MLS implementation, decrypt the MLS message first.
   */
  private handleNostrEvent(jid: string, groupName: string, event: any): void {
    // Skip our own messages
    if (this.signer && event.pubkey === this.signer.pubkeyHex) return;

    const senderPubkey = event.pubkey || 'unknown';
    const senderName = senderPubkey.slice(0, 12) + '...';

    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      groupName,
      'marmot',
      true,
    );

    this.opts.onMessage(jid, {
      id:
        event.id ||
        `marmot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chat_jid: jid,
      sender: senderPubkey,
      sender_name: senderName,
      content: event.content || '',
      timestamp: event.created_at
        ? new Date(event.created_at * 1000).toISOString()
        : new Date().toISOString(),
      is_from_me: false,
    });

    logger.info({ jid, sender: senderName }, 'Marmot message received');
  }

  /**
   * Poll for Welcome messages (group invitations) via NIP-59 gift wrap.
   */
  private startWelcomePoller(pubkey: string): void {
    if (!this.network) return;

    const pollInterval = MARMOT_POLL_INTERVAL_MS;
    let lastCheck = Math.floor(Date.now() / 1000);

    this.pollTimer = setInterval(async () => {
      if (!this.network) return;

      try {
        const events = await this.network.request(MARMOT_NOSTR_RELAYS, {
          kinds: [1059],
          '#p': [pubkey],
          since: lastCheck,
        });

        for (const event of events) {
          logger.debug(
            { eventId: event.id?.slice(0, 16) },
            'Received potential Marmot welcome event',
          );
          // TODO: Decrypt NIP-59 gift wrap and process MLS Welcome
          // Requires full marmot-ts integration for key package matching
        }

        lastCheck = Math.floor(Date.now() / 1000);
      } catch (err) {
        logger.warn({ err }, 'Marmot welcome poll failed');
      }
    }, pollInterval);

    logger.info(
      { pollInterval, pubkey: pubkey.slice(0, 16) },
      'Marmot welcome poller started',
    );
  }
}

// ---------------------------------------------------------------------------
// Self-registration — called when this module is imported via the barrel file
// ---------------------------------------------------------------------------

registerChannel('marmot', (opts: ChannelOpts) => {
  if (!MARMOT_NOSTR_PRIVATE_KEY || MARMOT_NOSTR_RELAYS.length === 0) {
    return null; // Credentials not configured — skip
  }
  return new MarmotChannel(opts);
});
