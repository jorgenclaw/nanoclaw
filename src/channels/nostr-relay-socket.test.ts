import net from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { GuardedWebSocket } from './nostr-relay-socket.js';

describe('GuardedWebSocket', () => {
  let server: net.Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('survives a relay reset after nostr-tools has cleared onerror', async () => {
    // A "relay" that accepts the TCP connection, never answers the upgrade,
    // then resets — the relay.nostr.band failure mode.
    server = net.createServer((sock) => setTimeout(() => sock.resetAndDestroy(), 50));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    try {
      const ws = new GuardedWebSocket(`ws://127.0.0.1:${port}`);
      // What nostr-tools' handleHardClose does after a connect timeout.
      ws.onerror = null;
      expect(ws.listenerCount('error')).toBeGreaterThan(0);

      await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught).toEqual([]);
  });
});
