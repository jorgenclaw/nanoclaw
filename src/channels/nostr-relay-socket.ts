import WebSocket from 'ws';

import { log } from '../log.js';

/**
 * WebSocket for nostr-tools' relay pool that can never crash the host.
 *
 * When a relay connect times out, nostr-tools gives up on the socket and
 * clears its handler (`ws.onerror = null`) but leaves the socket half-open.
 * If the relay later resets it, `ws` emits 'error' with no listener and Node
 * turns that into an uncaught exception. relay.nostr.band did exactly this
 * (TLS hangs, reset at ~19.5 s) and crash-looped the host every ~20 s from
 * 2026-10-02. A permanent listener turns that into a debug log line.
 */
export class GuardedWebSocket extends WebSocket {
  constructor(address: string, protocols?: string | string[]) {
    super(address, protocols);
    this.on('error', (err: Error) => {
      log.debug('Nostr relay socket error', { url: address, err: err.message });
    });
  }
}
