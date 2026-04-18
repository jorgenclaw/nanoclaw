#!/usr/bin/env node
/**
 * protond — Proton authentication daemon.
 *
 * Mirrors the architecture of tools/nostr-signer/index.js:
 *   - Reads Proton passphrase from Linux kernel keyring at startup
 *   - Authenticates to Proton via SRP
 *   - Holds session tokens + decrypted private key in memory
 *   - Serves a Unix socket with JSON request/response protocol
 *   - Auto-refreshes tokens before expiry
 *
 * Socket: $XDG_RUNTIME_DIR/protond.sock (default /run/user/1000/protond.sock)
 * Keyring key name: "proton_pass"
 *
 * Setup:
 *   keyctl add user proton_pass "YOUR_PROTON_PASSPHRASE" @u
 *   node tools/protond/index.js
 */

import net from 'node:net';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { authenticate, getSession, destroySession, apiCall } from './auth.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const SOCKET_PATH = process.env.PROTOND_SOCKET
  || `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() || 1000}`}/protond.sock`;

const PROTON_USERNAME = process.env.PROTON_USERNAME || 'jorgenclaw@proton.me';
const KEYRING_KEY_NAME = 'proton_pass';

// ─── Kernel keyring ──────────────────────────────────────────────────────────

function readKeyring(keyName) {
  try {
    const keyId = execSync(`keyctl search @u user ${keyName}`, { encoding: 'utf8' }).trim();
    if (!keyId) throw new Error(`Key "${keyName}" not found in user keyring`);
    const value = execSync(`keyctl print ${keyId}`, { encoding: 'utf8' }).trim();
    if (!value) throw new Error(`Key "${keyName}" is empty`);
    return value;
  } catch (err) {
    throw new Error(
      `Failed to read "${keyName}" from kernel keyring: ${err.message}\n` +
      `Store it with: keyctl add user ${keyName} "YOUR_PASSPHRASE" @u`
    );
  }
}

// ─── Request handlers ────────────────────────────────────────────────────────

const handlers = {
  async ping() {
    const sess = getSession();
    return {
      ok: true,
      authenticated: !!sess,
      session_age_s: sess ? Math.floor((Date.now() - (sess.expiresAt - 86400_000)) / 1000) : null,
    };
  },

  async session() {
    const sess = getSession();
    if (!sess) throw new Error('Not authenticated');
    return {
      uid: sess.uid,
      accessToken: sess.accessToken,
      expiresAt: new Date(sess.expiresAt).toISOString(),
    };
  },

  // ── Calendar operations (delegated to calendar-api.js when built) ────────

  async 'calendar.list'() {
    const data = await apiCall('GET', '/calendar/v1');
    return { calendars: data.Calendars || [] };
  },

  async 'calendar.events'(params) {
    const { calendarId, start, end, page = 0, pageSize = 100 } = params || {};
    if (!calendarId) throw new Error('calendarId required');
    let path = `/calendar/v1/${calendarId}/events?Page=${page}&PageSize=${pageSize}`;
    if (start) path += `&Start=${Math.floor(new Date(start).getTime() / 1000)}`;
    if (end) path += `&End=${Math.floor(new Date(end).getTime() / 1000)}`;
    const data = await apiCall('GET', path);
    return { events: data.Events || [], total: data.Total };
  },

  async 'calendar.event'(params) {
    const { calendarId, eventId } = params || {};
    if (!calendarId || !eventId) throw new Error('calendarId and eventId required');
    const data = await apiCall('GET', `/calendar/v1/${calendarId}/events/${eventId}`);
    return { event: data.Event };
  },

  async 'calendar.keys'(params) {
    const { calendarId } = params || {};
    if (!calendarId) throw new Error('calendarId required');
    const data = await apiCall('GET', `/calendar/v1/${calendarId}/keys`);
    return { keys: data.Keys || [] };
  },

  async 'calendar.passphrase'(params) {
    const { calendarId } = params || {};
    if (!calendarId) throw new Error('calendarId required');
    const data = await apiCall('GET', `/calendar/v1/${calendarId}/passphrase`);
    return { passphrases: data.Passphrases || [] };
  },

  async 'calendar.members'(params) {
    const { calendarId } = params || {};
    if (!calendarId) throw new Error('calendarId required');
    const data = await apiCall('GET', `/calendar/v1/${calendarId}/members`);
    return { members: data.Members || [] };
  },

  // Placeholder for write operations — will be built after read is verified.
  async 'calendar.create'(params) {
    throw new Error('calendar.create not yet implemented — read operations first');
  },
  async 'calendar.update'(params) {
    throw new Error('calendar.update not yet implemented');
  },
  async 'calendar.delete'(params) {
    throw new Error('calendar.delete not yet implemented');
  },
};

// ─── Socket server ───────────────────────────────────────────────────────────

async function handleRequest(data) {
  let req;
  try {
    req = JSON.parse(data);
  } catch {
    return JSON.stringify({ error: 'Invalid JSON' });
  }

  const { method, params } = req;
  if (!method || typeof method !== 'string') {
    return JSON.stringify({ error: 'Missing "method" field' });
  }

  const handler = handlers[method];
  if (!handler) {
    return JSON.stringify({ error: `Unknown method: ${method}` });
  }

  try {
    const result = await handler(params);
    return JSON.stringify({ ok: true, ...result });
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

function startSocketServer() {
  // Clean up stale socket file.
  if (fs.existsSync(SOCKET_PATH)) {
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
  }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      // Simple framing: one JSON object per line.
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          handleRequest(line).then((resp) => {
            conn.write(resp + '\n');
          });
        }
      }
    });
    conn.on('error', () => {}); // Ignore broken pipe etc.
  });

  server.listen(SOCKET_PATH, () => {
    // Owner-only permissions.
    fs.chmodSync(SOCKET_PATH, 0o600);
    console.log(`[protond] listening on ${SOCKET_PATH}`);
  });

  return server;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[protond] starting...');

  // Read passphrase from kernel keyring.
  let passphrase;
  try {
    passphrase = readKeyring(KEYRING_KEY_NAME);
    console.log('[protond] passphrase loaded from keyring');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Authenticate via SRP.
  try {
    await authenticate(PROTON_USERNAME, passphrase);
  } catch (err) {
    console.error('[protond] authentication failed:', err.message);
    process.exit(1);
  }

  // Clear passphrase from this scope (auth.js holds the session, not the password).
  passphrase = null;

  // Start socket server.
  const server = startSocketServer();

  // Graceful shutdown.
  const shutdown = (signal) => {
    console.log(`[protond] ${signal} received, shutting down`);
    destroySession();
    server.close();
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[protond] fatal:', err);
  process.exit(1);
});
