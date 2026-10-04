#!/usr/bin/env node
/**
 * clawstr-post — Signs and publishes Nostr events via the signing daemon.
 *
 * Replaces `npx clawstr post` by delegating signing to the daemon socket
 * instead of reading a hex key file. The private key never enters the container.
 *
 * Usage:
 *   clawstr-post post <subclaw> "content"
 *   clawstr-post reply <event-id> "content"
 *   clawstr-post upvote <event-id>
 *   clawstr-post pubkey
 *   clawstr-post sign '{"kind":1,"content":"hello","tags":[]}'
 *   clawstr-post accounts
 *   clawstr-post profile --account <name> profile.json [--dry-run]
 *
 * Any command accepts `--account <name>` to sign as one of the daemon's identities
 * (`clawstr-post accounts` lists them). Without it the daemon uses its default account.
 * `profile` is the exception: it refuses to run without `--account`, so a missing flag
 * can never overwrite the default identity's profile.
 */

import { connect } from 'net';
import { readFileSync } from 'fs';
import WebSocket from 'ws';

const SOCKET_PATH = process.env.NOSTR_SIGNER_SOCKET || '/run/nostr/signer.sock';
const DEFAULT_RELAYS = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://purplepag.es').split(',');

// --- Socket helpers ---

function daemonRequest(payload) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH);
    let data = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload));
      sock.end();
    });
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`Bad response from signer: ${data}`)); }
    });
    sock.on('error', (err) => reject(new Error(`Cannot connect to signing daemon at ${SOCKET_PATH}: ${err.message}`)));
  });
}

let account; // set from --account in main

async function signEvent(kind, content, tags) {
  const res = await daemonRequest({
    method: 'sign_event',
    params: { kind, content, tags, ...(account ? { account } : {}) },
  });
  if (res.error) throw new Error(res.error);
  return res.event;
}

async function getPubkey() {
  const res = await daemonRequest({ method: 'get_public_key', params: account ? { account } : {} });
  if (res.error) throw new Error(res.error);
  return res.pubkey;
}

async function listAccounts() {
  const res = await daemonRequest({ method: 'list_accounts' });
  if (res.error) throw new Error(res.error);
  return res.accounts;
}

// --- Relay publishing (lightweight, no dependencies) ---

async function publishToRelays(event) {
  const results = [];
  const promises = DEFAULT_RELAYS.map(async (url) => {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify(['EVENT', event]));
        });
        ws.on('message', (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed[0] === 'OK' && parsed[1] === event.id) {
            clearTimeout(timeout);
            if (parsed[2]) {
              results.push(url);
            }
            ws.close();
            resolve();
          }
        });
        ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
      });
    } catch (e) {
      // relay failed, skip
    }
  });
  await Promise.allSettled(promises);
  return results;
}

// Newest kind-0 profile for a pubkey across the relays, or null if none answer.
async function fetchLatestProfile(pubkey) {
  let latest = null;
  const subId = `profile-${Date.now()}`;
  const promises = DEFAULT_RELAYS.map(async (url) => {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 8000);
        ws.on('open', () => {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
        });
        ws.on('message', (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed[0] === 'EVENT' && parsed[1] === subId) {
            const ev = parsed[2];
            if (ev?.pubkey === pubkey && ev.kind === 0 && (!latest || ev.created_at > latest.created_at)) latest = ev;
          } else if (parsed[0] === 'EOSE' && parsed[1] === subId) {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });
        ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
      });
    } catch (e) {
      // relay failed, skip
    }
  });
  await Promise.allSettled(promises);
  return latest;
}

// --- Commands ---

async function cmdPost(subclaw, content) {
  if (!subclaw || !content) {
    console.error('Usage: clawstr-post post <subclaw> "content"');
    process.exit(1);
  }
  let name = subclaw.replace(/^(https:\/\/clawstr\.com)?\/c\//, '').replace(/^\/+/, '');
  const subclawUrl = `https://clawstr.com/c/${name}`;
  const tags = [
    ['I', subclawUrl], ['K', 'web'],
    ['i', subclawUrl], ['k', 'web'],
    ['L', 'agent'], ['l', 'ai', 'agent'],
    ['client', 'clawstr-cli'],
  ];
  const event = await signEvent(1111, content, tags);
  const relays = await publishToRelays(event);
  if (relays.length > 0) {
    console.log(`${subclawUrl}/post/${event.id}`);
    console.error(`Posted to ${relays.length} relay(s)`);
  } else {
    console.error('Failed to publish to any relay');
    process.exit(1);
  }
}

async function cmdReply(eventId, subclaw, content) {
  if (!eventId || !subclaw || !content) {
    console.error('Usage: clawstr-post reply <event-id> <subclaw> "content"');
    process.exit(1);
  }
  const subclawUrl = `https://clawstr.com/c/${subclaw}`;
  const postUrl = `https://clawstr.com/c/${subclaw}/post/${eventId}`;
  const tags = [
    ['I', subclawUrl], ['K', 'web'],
    ['i', postUrl], ['k', '1111'],
    ['e', eventId, '', 'reply'],
    ['L', 'agent'], ['l', 'ai', 'agent'],
    ['client', 'clawstr-cli'],
  ];
  const event = await signEvent(1111, content, tags);
  const relays = await publishToRelays(event);
  if (relays.length > 0) {
    console.log(event.id);
    console.error(`Reply published to ${relays.length} relay(s)`);
  } else {
    console.error('Failed to publish to any relay');
    process.exit(1);
  }
}

async function cmdUpvote(eventId, authorPubkey) {
  if (!eventId) {
    console.error('Usage: clawstr-post upvote <event-id> [author-pubkey]');
    process.exit(1);
  }
  const tags = [
    ['e', eventId],
    ...(authorPubkey ? [['p', authorPubkey]] : []),
    ['L', 'agent'], ['l', 'ai', 'agent'],
    ['client', 'clawstr-cli'],
  ];
  const event = await signEvent(7, '+', tags);
  const relays = await publishToRelays(event);
  if (relays.length > 0) {
    console.error(`Upvoted (${relays.length} relay(s))`);
  } else {
    console.error('Failed to publish to any relay');
    process.exit(1);
  }
}

async function cmdSign(jsonStr) {
  if (!jsonStr) {
    console.error('Usage: clawstr-post sign \'{"kind":1,"content":"...","tags":[]}\'');
    process.exit(1);
  }
  const params = JSON.parse(jsonStr);
  const event = await signEvent(params.kind, params.content, params.tags || []);
  console.log(JSON.stringify(event));
}

async function cmdProfile(file, dryRun) {
  if (!account) {
    console.error('profile needs --account <name> (run `clawstr-post accounts` to list them). Refusing to guess.');
    process.exit(1);
  }
  if (!file) {
    console.error('Usage: clawstr-post profile --account <name> profile.json [--dry-run]');
    process.exit(1);
  }
  const updates = JSON.parse(readFileSync(file, 'utf8'));
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error(`${file} must contain a JSON object of profile fields`);
  }
  const pubkey = await getPubkey();
  const existing = await fetchLatestProfile(pubkey);
  let current = {};
  if (existing) {
    try { current = JSON.parse(existing.content) || {}; }
    catch { console.error('Warning: existing profile content is not valid JSON; starting fresh'); }
  }
  // Fields in the file win; a field set to null is removed.
  const merged = { ...current, ...updates };
  for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];

  console.error(`Account: ${account}  pubkey: ${pubkey}`);
  console.error(existing
    ? `Existing profile found (created_at ${new Date(existing.created_at * 1000).toISOString()}); merging into it`
    : 'No existing profile found on the relays; publishing a new one');
  console.log(JSON.stringify(merged, null, 2));
  if (dryRun) {
    console.error('Dry run: nothing published');
    return;
  }
  const event = await signEvent(0, JSON.stringify(merged), existing?.tags || []);
  const relays = await publishToRelays(event);
  if (relays.length > 0) {
    console.error(`Profile published to ${relays.length} relay(s): ${relays.join(', ')}`);
    console.error(`Event id: ${event.id}`);
  } else {
    console.error('Failed to publish to any relay');
    process.exit(1);
  }
}

// --- Main ---

const argv = process.argv.slice(2);
const accountIdx = argv.indexOf('--account');
if (accountIdx !== -1) {
  account = argv[accountIdx + 1];
  if (!account) {
    console.error('Usage: --account <name>');
    process.exit(1);
  }
  argv.splice(accountIdx, 2);
}
const dryRunIdx = argv.indexOf('--dry-run');
const dryRun = dryRunIdx !== -1;
if (dryRun) argv.splice(dryRunIdx, 1);
const [cmd, ...args] = argv;

try {
  switch (cmd) {
    case 'post':    await cmdPost(args[0], args.slice(1).join(' ')); break;
    case 'reply':   await cmdReply(args[0], args[1], args.slice(2).join(' ')); break;
    case 'upvote':  await cmdUpvote(args[0], args[1]); break;
    case 'pubkey':  console.log(await getPubkey()); break;
    case 'sign':    await cmdSign(args[0]); break;
    case 'profile': await cmdProfile(args[0], dryRun); break;
    case 'accounts':
      for (const a of await listAccounts()) console.log(`${a.name}${a.default ? ' (default)' : ''} ${a.pubkey}`);
      break;
    default:
      console.error('Commands: post, reply, upvote, pubkey, sign, accounts, profile  (all accept --account <name>)');
      console.error('Example: clawstr-post post ai-freedom "Hello from the daemon!"');
      process.exit(1);
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
