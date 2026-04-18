# NanoClaw V2 Migration Guide

Generated: 2026-04-18
Base (merge-base with upstream/main): `eba94b72`
HEAD at generation: `9d8f8b8f` (branch: feat/quad-inbox-deferred)
Upstream V2 target: `5ed5b72f` (branch: upstream/v2)
Upstream V1 (main): `eba94b72`

This guide captures every customization in the Jorgenclaw fork of NanoClaw, with enough detail for a fresh Claude session to reimplement each one on a clean V2 checkout. V2 is a ground-up architectural rewrite — merging is not viable. Every customization must be rebuilt to fit V2's patterns.

---

## Migration Plan

### Architecture mapping (V1 → V2)

| V1 Concept | V2 Equivalent |
|------------|---------------|
| `Channel` interface (`connect`, `sendMessage`, `ownsJid`) | `ChannelAdapter` interface (`setup`, `deliver`, `isConnected`) |
| Channel registration via `registerChannel()` in `src/channels/index.ts` | Self-registration barrel: import triggers `registerChannelAdapter()` |
| `RegisteredGroup` (jid, folder, trigger) | `AgentGroup` + `MessagingGroup` + `MessagingGroupAgent` wiring |
| File-based IPC (`messages/`, `tasks/` dirs) | SQLite session DBs (`inbound.db` + `outbound.db` per session) |
| `runContainerAgent(group, input)` | `wakeContainer(session)` — one container per session |
| `src/db.ts` (monolithic SQLite) | `src/db/*.ts` (central DB + per-session DBs) |
| `src/task-scheduler.ts` | `src/modules/scheduling/` (Tier 2 optional module) |
| `sender-allowlist.ts` | `src/modules/permissions/` (Tier 2 optional module) |
| `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` stdout parsing | Session DB polling (container writes `messages_out`, host reads) |
| `src/logger.ts` (pino) | `src/log.ts` (simple `log.info()` / `log.error()`) |
| npm | pnpm (host) + Bun (container agent-runner) |
| `store/messages.db` | `data/v2.db` (central) + `data/v2-sessions/{agentGroup}/{session}/` |

### Order of operations

1. **Check out clean V2** in a worktree
2. **Port config** — add all custom env vars to `src/config.ts`
3. **Port types** — define any custom types needed
4. **Port standalone modules** (health, transcription) — zero upstream coupling
5. **Port channels** — rewrite all 4 to `ChannelAdapter` interface
6. **Port credential proxy** — or decide to adopt V2's OneCLI flow
7. **Port security policy** — as a V2 Tier 2 module
8. **Port DB customizations** — token_usage table as a V2 migration
9. **Port container mounts** — adapt to V2's mount system
10. **Wire everything in index.ts** — fit into V2's boot sequence
11. **Port external tools** — copy `tools/` directory, verify mount paths
12. **Port skills** — copy `.claude/skills/`, verify compatibility
13. **Build and test**

### Risk areas

- **Credential proxy ↔ container-runner**: V2 still uses OneCLI SDK (`@onecli-sh/sdk ^0.3.1`). Our proxy replaces OneCLI entirely. Decision: keep proxy (more control, no OneCLI dependency) or adopt V2's OneCLI (less maintenance, upstream-compatible). Recommend keeping proxy — it's simpler and we control it.
- **Security policy ↔ container spawning**: V2 has `mount-security` as a default module, but our security policy is far more comprehensive (bash blocking, web restrictions, tool blocking, trust system). This should become a new Tier 2 module.
- **Session DB ↔ IPC media/reactions**: V1's IPC supported `filePath`, `reaction`, `image` message types with path resolution. V2 uses `messages_out.content` JSON blobs + `outbox/` file directory. Media and reactions need to be encoded as content JSON types.
- **Two-DB mount invariants**: V2 uses `journal_mode=DELETE` (not WAL) and open-write-close patterns. Any DB access in custom code must follow this pattern or risk stale reads across the container mount boundary.

### Staging

1. Get channels working first (Signal + Watch are daily drivers)
2. Then credential flow
3. Then security policy
4. Then everything else

---

## Applied Skills

No upstream skill branches were merged. All customizations are direct modifications or new files. The following skills are SKILL.md manifests only (no code changes from skill branches):

- `quad-inbox/SKILL.md` — Quad inbox processing instructions
- `test-pr/SKILL.md` — PR testing in worktrees
- `update/SKILL.md` + `update/scripts/fetch-upstream.sh` — Upstream update preview

**V2 action:** Copy `.claude/skills/` directory as-is. SKILL.md format appears unchanged in V2. Verify the `update` skill's fetch script still works with V2's branch structure.

---

## Skill Interactions

N/A — no upstream skill branches to conflict.

---

## Custom Channels

All 4 channels must be rewritten to V2's `ChannelAdapter` interface. The core behavioral logic (protocol handling, auth, transcription, dedup) stays the same; what changes is the integration surface.

### V2 ChannelAdapter Contract

Every channel must implement:

```typescript
interface ChannelAdapter {
  name: string;           // e.g. "Signal"
  channelType: string;    // e.g. "signal" — used in DB lookups
  supportsThreads: boolean;

  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  updateConversations?(conversations: ConversationConfig[]): void;
  openDM?(userHandle: string): Promise<string>;
}
```

`ChannelSetup` provides callbacks:
- `onInbound(platformId, threadId, InboundMessage)` — fire when message arrives
- `onMetadata(platformId, name?, isGroup?)` — fire with conversation metadata
- `onAction(questionId, selectedOption, userId)` — fire on card button clicks

Key differences from V1:
- No `connect()` — use `setup()` instead (receives callbacks)
- No `sendMessage()` — use `deliver()` (called by host delivery poll)
- No `ownsJid()` — routing is by `channelType` + `platformId` in central DB
- Inbound messages: call `onInbound()` instead of returning to a callback in index.ts
- `platformId` replaces `jid` (the platform-specific identifier, e.g. `+18102143598` or a group UUID)

Registration:
```typescript
import { registerChannelAdapter } from './adapter-registry.js';
registerChannelAdapter({
  factory: () => new SignalChannel(),
  containerConfig: {
    mounts: [...],
    env: {...}
  }
});
```

### Channel: Signal

**Intent:** Bidirectional messaging via Signal Protocol using TCP JSON-RPC to signal-cli daemon. Supports text, voice notes (transcription), images, reactions, quoted replies, and mentions.

**Current file:** `src/channels/signal.ts` (668 lines)

**V2 channelType:** `signal`
**supportsThreads:** `false` (Signal groups are flat conversations)

**Connection pattern (keep as-is):**
- Persistent TCP socket to signal-cli daemon at `SIGNAL_CLI_TCP_HOST:SIGNAL_CLI_TCP_PORT`
- JSON-RPC protocol (newline-delimited JSON)
- Auto-reconnect with 5s interval, exponential backoff after 3 attempts
- Subscription via `receive` RPC method

**platformId format:** Phone number (`+18102143598`) for DMs, group ID (`group.<base64>`) for groups. Note: V1 used `signal:` prefix in JIDs — V2 platformId drops the prefix (channelType handles disambiguation).

**Inbound message handling:**
- `handleReceiveEvent()` processes JSON-RPC receive responses
- Two event forms: `params.envelope` (broadcast) and `params.result.envelope` (subscription)
- Extract `dataMessage.message` as text content
- Resolve mentions: Signal uses U+FFFC placeholders with mention annotations — convert to `@name` text
- Voice notes: detect audio attachments by `contentType.startsWith('audio/')`, construct path as `~/.local/share/signal-cli/attachments/<id>`, transcribe via `transcribeAudio()`
- Image attachments: detect by `contentType.startsWith('image/')`, append `[Image: /workspace/attachments/<id>]`
- Quoted replies: extract `dataMessage.quote` → `quoted_message_id`, `quoted_text`, `quoted_author`

**V2 inbound adaptation:**
```typescript
// V1: called back to index.ts message handler
// V2: call onInbound from ChannelSetup
this.config.onInbound(platformId, null, {  // threadId=null (no threads)
  id: envelope.timestamp.toString(),
  kind: 'chat',
  content: {
    text: messageText,
    sender: senderIdentifier,
    senderName: resolvedName,
    quotedMessageId: quote?.id,
    quotedText: quote?.text,
    quotedAuthor: quote?.author,
    attachments: imageAttachments,  // [{path, contentType}]
  },
  timestamp: new Date(envelope.timestamp).toISOString(),
});
```

**Outbound delivery (V2 `deliver()`):**
```typescript
async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
  const content = message.content as { text?: string };
  if (!content.text) return undefined;

  // Handle file attachments from message.files
  const attachments = message.files?.map(f => {
    const tmpPath = `/tmp/signal-attach-${Date.now()}`;
    fs.writeFileSync(tmpPath, f.data);
    return tmpPath;
  });

  const result = await this.sendRpc('send', {
    account: SIGNAL_PHONE_NUMBER,
    recipients: [platformId],  // no "signal:" prefix
    message: content.text,
    attachments: attachments || [],
  });

  // Clean up temp files
  attachments?.forEach(p => fs.unlinkSync(p));

  return result?.timestamp?.toString();
}
```

**Watchdog (keep as-is):**
- Every 5 minutes: check subscription liveness (10+ min no events → force reconnect)
- Group staleness check (6+ hours → restart signal-cli via `systemctl --user restart signal-cli`)

**Reactions (keep as-is):**
```typescript
// V1 called via Channel.sendReaction() from IPC
// V2: encode as a delivery action or message kind
async sendReaction(platformId: string, messageId: string, emoji: string, targetAuthor?: string) {
  await this.sendRpc('sendReaction', {
    account: SIGNAL_PHONE_NUMBER,
    recipients: [platformId],
    emoji,
    targetTimestamp: parseInt(messageId, 10),
    targetAuthor: targetAuthor || SIGNAL_PHONE_NUMBER,
  });
}
```

**Container mounts needed (register via `containerConfig`):**
```typescript
containerConfig: {
  mounts: [
    { hostPath: '~/.local/share/signal-cli/attachments/', containerPath: '/workspace/attachments', readonly: true },
  ]
}
```

**Dependencies:** `transcribeAudio` from `src/transcription.ts`

**Config vars:** `SIGNAL_PHONE_NUMBER`, `SIGNAL_CLI_TCP_HOST` (default `127.0.0.1`), `SIGNAL_CLI_TCP_PORT` (default `7583`)

---

### Channel: Watch (T-Watch S3)

**Intent:** HTTP server channel for T-Watch S3 wearable. Accepts text/audio input with a 12-second sync timeout for fast replies, plus a polling queue for slow replies.

**Current file:** `src/channels/watch.ts` (767 lines)

**V2 channelType:** `watch`
**supportsThreads:** `false`

**Connection pattern:**
- HTTP server on `WATCH_HTTP_BIND:WATCH_HTTP_PORT` (default `0.0.0.0:3000`)
- Authentication via timing-safe `X-Watch-Token` header comparison
- Server starts in `setup()`, stops in `teardown()`

**Endpoints (all must be preserved):**

1. `POST /api/watch/message` — Main message ingestion
   - Body: JSON `{text}` or raw WAV audio (`Content-Type: audio/wav`)
   - Audio → transcribe via `transcribeAudio()` → clean Whisper annotations
   - Returns sync reply within `WATCH_SYNC_TIMEOUT_MS` (default 45s) if agent responds fast enough
   - Otherwise returns empty, queues reply for poll pickup
   - Response format: `{reply: string}` or `{reply: ""}` (pending)

2. `GET /api/watch/poll` — Outgoing message queue drain
   - Returns `{messages: [{text, timestamp}]}` — all queued replies since last poll
   - Watch firmware polls every ~60s

3. `POST /api/watch/notify` — External notification injection
   - Body: `{text, source?, priority?}`
   - Adds to notification ring buffer (50 items, 1-hour TTL)

4. `GET /api/watch/notifications` — Notification feed
   - Query: `?since=<timestamp>` for incremental fetch
   - Returns `{notifications: [{text, source, priority, timestamp}]}`

5. `POST /api/watch/memo` — Voice memo capture
   - Body: raw WAV audio
   - Transcribe → append to `groups/<folder>/memory/captures.md` as timestamped entry
   - Returns `{memo: transcribedText}`

6. `POST /api/watch/reminder` — Voice reminder
   - Body: raw WAV audio
   - Transcribe → send to agent as "Set a reminder: <text>" → agent parses time naturally
   - Returns `{reminder: transcribedText}`

**V2 inbound adaptation:**
The Watch channel is unique — it needs sync responses. V2's async model (write to session DB → container processes → delivery poll picks up reply) doesn't naturally support sync replies. Two approaches:

**Option A (recommended): Keep the sync/async dual path.**
- On POST /api/watch/message: call `onInbound()`, then poll the outbound.db directly for up to `WATCH_SYNC_TIMEOUT_MS` waiting for a response. If one arrives, return it synchronously and mark delivered. If timeout, return empty and let normal delivery poll handle it.
- This requires the Watch adapter to have access to session DB paths, which is non-standard for V2 adapters. May need to extend the adapter interface or use a side-channel.

**Option B: Pure async with aggressive polling.**
- POST /api/watch/message returns immediately with `{reply: ""}`
- Watch firmware polls /api/watch/poll at higher frequency (every 3-5s instead of 60s)
- Delivery poll in V2 runs every ~1s for active containers, so replies should appear within 2-3s
- The Watch `deliver()` method queues the reply text for the poll endpoint

Option B is cleaner architecturally. The Watch firmware already supports polling. The 60s poll interval can be reduced when expecting a reply.

**V2 deliver():**
```typescript
async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
  const content = message.content as { text?: string };
  if (!content.text) return undefined;

  const normalized = normalizeForWatch(content.text);

  // Queue for poll pickup
  this.pendingReplies.push({ text: normalized, timestamp: Date.now() });

  // Also resolve any sync waiters
  if (this.syncResolver) {
    this.syncResolver(normalized);
    this.syncResolver = null;
  }

  // Mirror to Signal if configured
  if (this.mirrorChannel && WATCH_SIGNAL_MIRROR_JID) {
    await this.mirrorChannel.deliver(WATCH_SIGNAL_MIRROR_JID, null, message);
  }

  return `watch-${Date.now()}`;
}
```

**Text normalization (keep as-is):**
`normalizeForWatch()` converts Unicode punctuation to ASCII (em-dashes → --, smart quotes → straight quotes, bullets → *, etc.) and strips remaining non-ASCII. This is critical — the T-Watch S3 LCD can only render basic ASCII.

**Signal mirroring:**
V1 used `setMirrorTarget()` to relay all exchanges to a Signal chat. In V2, this can be done by having the Watch adapter hold a reference to the Signal adapter and calling its `deliver()` on every inbound/outbound exchange.

**Container mounts needed:**
```typescript
containerConfig: {
  mounts: [
    { hostPath: '<STORE_DIR>/watch-uploads', containerPath: '/workspace/watch-uploads', readonly: false },
  ]
}
```

**Config vars:** `WATCH_AUTH_TOKEN`, `WATCH_HTTP_PORT` (default `3000`), `WATCH_HTTP_BIND` (default `0.0.0.0`), `WATCH_JID` (fixed identifier), `WATCH_GROUP_FOLDER` (default `watch`), `WATCH_SYNC_TIMEOUT_MS` (default `45000`), `WATCH_SIGNAL_MIRROR_JID` (optional)

**Dependencies:** `transcribeAudio` from `src/transcription.ts`

---

### Channel: White Noise

**Intent:** Encrypted messaging over Nostr network using MLS protocol via White Noise CLI (`wn`).

**Current file:** `src/channels/whitenoise.ts` (370 lines)

**V2 channelType:** `whitenoise`
**supportsThreads:** `false`

**Connection pattern:**
- Polling architecture (no persistent connection)
- `setInterval()` polls registered groups every 3 seconds
- Calls `wn` CLI binary with `--json --socket WN_SOCKET_PATH --account WN_ACCOUNT_PUBKEY`

**platformId format:** Hex group ID (e.g. `1971c22b90d180cfcb11a965ed9920fe`). V1 used `whitenoise:` prefix — V2 drops it.

**Inbound flow:**
- `pollAllGroups()` iterates conversations from `ChannelSetup.conversations`
- `pollGroup(platformId)` calls `wn messages list <groupId>` (JSON output)
- Deduplication via `lastSeenMessageIds` map (per-group latest message ID)
- First poll: record last ID without processing (prevents backlog flood)
- Media: detect image MIME types, map `media_cache/` paths to `/run/whitenoise/media_cache/` for container

**V2 inbound:**
```typescript
this.config.onInbound(platformId, null, {
  id: msg.id,
  kind: 'chat',
  content: {
    text: msg.content,
    sender: msg.sender_pubkey,
    senderName: msg.sender_name || msg.sender_pubkey.substring(0, 12),
    attachments: mediaAttachments,
  },
  timestamp: new Date(msg.timestamp * 1000).toISOString(),
});
```

**V2 deliver():**
```typescript
async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
  const content = message.content as { text?: string };
  if (!content.text) return undefined;

  await this.execWn(['messages', 'send', platformId, content.text]);

  // Handle file attachments
  if (message.files?.length) {
    for (const file of message.files) {
      const tmpPath = `/tmp/wn-attach-${Date.now()}-${file.filename}`;
      fs.writeFileSync(tmpPath, file.data);
      await this.execWn(['media', 'upload', platformId, tmpPath, '--send']);
      fs.unlinkSync(tmpPath);
    }
  }

  return undefined; // WN CLI doesn't return message IDs
}
```

**Reactions:**
```typescript
// wn messages react <groupId> <messageId> <emoji>
async sendReaction(platformId: string, messageId: string, emoji: string) {
  await this.execWn(['messages', 'react', platformId, messageId, emoji]);
}
```

**Container mounts:**
```typescript
containerConfig: {
  mounts: [
    { hostPath: '~/.local/share/whitenoise-cli/release/wnd.sock', containerPath: '/run/whitenoise/wnd.sock', readonly: false },
    { hostPath: '~/.local/share/whitenoise-cli/release/media_cache', containerPath: '/run/whitenoise/media_cache', readonly: true },
    // WN binaries for container-side access:
    { hostPath: '~/whitenoise-rs/target/release/wn', containerPath: '/usr/local/bin/wn', readonly: true },
    { hostPath: '~/whitenoise-rs/target/release/wnd', containerPath: '/usr/local/bin/wnd', readonly: true },
  ]
}
```

**Config vars:** `WN_BINARY_PATH`, `WN_SOCKET_PATH`, `WN_ACCOUNT_PUBKEY`

---

### Channel: Nostr DM (NIP-17)

**Intent:** Private direct messages over Nostr network using NIP-17 gift-wrap encryption. Supports text and encrypted file attachments (kind 15).

**Current file:** `src/channels/nostr-dm.ts` (486 lines)

**V2 channelType:** `nostr-dm`
**supportsThreads:** `false`

**Connection pattern:**
- WebSocket relay pool via `nostr-tools/pool` (SimplePool)
- Subscribes to kind 1059 (gift wraps) tagged with `#p: [ownPubkey]`
- Signing daemon at `NOSTR_SIGNER_SOCKET` (Unix socket) for NIP-17 encryption/decryption

**platformId format:** Hex pubkey of the contact (e.g. `45f1a8b3...`). V1 used `nostr:` prefix — V2 drops it.

**Inbound flow:**
- Subscribe to relays for kind 1059 events
- For each event: call daemon `unwrap_gift_wrap` → get inner Rumor
- Kind 14 = text DM, Kind 15 = encrypted file
- Allowlist check: `NOSTR_DM_ALLOWLIST` set filters by sender pubkey
- Profile resolution: fetch kind 0 metadata, cache 24h, fallback to pubkey prefix

**Encrypted file handling (kind 15) — critical, non-obvious:**
```typescript
// kind 15 content = Blossom URL of encrypted blob
// Tags contain decryption params:
//   ['decryption-key', hexKey]
//   ['decryption-nonce', hexNonce]
//   ['encryption-algorithm', 'aes-256-gcm']
//   ['m', mimeType]
//   ['x', originalHash]
//
// Download blob, decrypt:
//   - Last 16 bytes of ciphertext = GCM auth tag
//   - Remaining bytes = actual ciphertext
//   - Decrypt with AES-256-GCM using key, nonce (IV), auth tag
//   - Save to groups/<folder>/attachments/<hash>.<ext>
```

**V2 inbound:**
```typescript
this.config.onInbound(senderPubkey, null, {
  id: rumor.id,
  kind: 'chat',
  content: {
    text: rumor.content,
    sender: `nostr:${senderPubkey}`,
    senderName: profile?.display_name || senderPubkey.substring(0, 12),
    attachments: decryptedFiles,  // [{path, contentType}]
  },
  timestamp: new Date(rumor.created_at * 1000).toISOString(),
});
```

**V2 deliver():**
```typescript
async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
  const content = message.content as { text?: string };
  if (!content.text) return undefined;

  // Call daemon to wrap DM → produces 2 gift-wrap events
  const { recipientWrap, selfWrap } = await this.daemonRequest('wrap_dm', {
    recipient_pubkey: platformId,
    content: content.text,
  });

  // Publish both to relays
  await Promise.all([
    this.pool.publish(NOSTR_DM_RELAYS, recipientWrap),
    this.pool.publish(NOSTR_DM_RELAYS, selfWrap),
  ]);

  return recipientWrap.id;
}
```

**Daemon protocol (Unix socket, JSON):**
```typescript
// Request: { method: string, params: object }
// Response: { result: object } or { error: string }
// Methods:
//   get_public_key → { pubkey: string }
//   unwrap_gift_wrap { event: NostrEvent } → { rumor: Rumor, sender: string }
//   wrap_dm { recipient_pubkey: string, content: string } → { recipient_wrap: Event, self_wrap: Event }
```

**Container mounts:**
```typescript
containerConfig: {
  mounts: [
    { hostPath: '/run/nostr/signer.sock', containerPath: '/run/nostr/signer.sock', readonly: false },
  ]
}
```

**Dependencies:** `nostr-tools` (npm package), `ws` (WebSocket), signing daemon

**Config vars:** `NOSTR_SIGNER_SOCKET`, `NOSTR_DM_RELAYS` (comma-separated relay URLs), `NOSTR_DM_ALLOWLIST` (comma-separated hex pubkeys)

---

## Custom Infrastructure

### Transcription (standalone, low risk)

**Intent:** Local voice transcription via whisper.cpp with automatic fallback to OpenAI Whisper API.

**Current file:** `src/transcription.ts` (110 lines)

**V2 adaptation:** Zero changes needed. This is a pure utility module with no upstream coupling.

**How to apply:**
1. Copy `src/transcription.ts` as-is to V2 checkout
2. Add config vars to `src/config.ts`:
   ```typescript
   export const WHISPER_BIN = process.env.WHISPER_BIN ?? path.join(HOME_DIR, '.local/bin/whisper-cli');
   export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? path.join(HOME_DIR, '.local/share/whisper/models/ggml-base.en.bin');
   ```
3. Import where needed (Signal and Watch channels use it)

**Key implementation details:**
- `transcribeAudio(filePath)` — main entry. Converts input to 16kHz mono WAV via ffmpeg, tries local, falls back to OpenAI
- `toWav(filePath)` — `ffmpeg -i input -ar 16000 -ac 1 output.wav`
- `transcribeLocal(wavPath)` — `whisper-cli -m MODEL -f FILE --output-txt --no-prints -nt`, reads `.txt` output file
- `transcribeOpenAI(wavPath)` — POST to `https://api.openai.com/v1/audio/transcriptions` with `model: whisper-1`
- On local failure: logs health alert, continues with OpenAI

---

### Health Monitor (standalone, low risk)

**Intent:** Error deduplication and admin alerts. Prevents alert fatigue by suppressing repeated errors within a 1-hour window.

**Current file:** `src/health.ts` (58 lines)

**V2 adaptation:** Nearly zero changes. Replace channel `sendMessage` call with whatever V2 uses for host-initiated messages to admin.

**How to apply:**
1. Copy `src/health.ts` to V2 checkout
2. Adapt `initHealthMonitor()` to accept a V2-compatible send function:
   ```typescript
   // V1: takes channel.sendMessage
   // V2: take a function that writes to the admin's session DB or uses adapter.deliver()
   export function initHealthMonitor(opts: {
     sendAlert: (text: string) => Promise<void>;
   }) { ... }
   ```
3. In V2 boot sequence, wire `sendAlert` to deliver a message to the owner's DM

**Key implementation:**
- `DEDUP_WINDOW_MS = 3600000` (1 hour)
- `reportError(category, message, details)` — check if category was reported within window, skip if so
- `clearAlert(category)` — reset timer when issue resolved
- Alert format: `⚠️ [category] message\n\ndetails`

---

### Credential Proxy (high risk, critical decision)

**Intent:** HTTP proxy that injects real API credentials into container requests. Containers connect to the proxy instead of Anthropic directly and never see real keys.

**Current file:** `src/credential-proxy.ts` (126 lines)

**V2 decision needed:** V2 uses OneCLI SDK v0.3.1 for credential injection. Our proxy completely replaces OneCLI. Options:

**Option A (recommended): Keep our proxy.**
- Simpler, no OneCLI dependency
- We control the credential flow entirely
- Works on any Linux host without OneCLI installation
- V2's container-runner calls `onecli.ensureAgent()` and `applyContainerConfig()` — we'd remove those calls and inject our proxy env vars instead

**Option B: Adopt V2's OneCLI flow.**
- Less custom code to maintain
- But OneCLI has been a source of bugs (the Proton /auth lockout was from protond SRP, OneCLI SDK has had breaking changes)
- Requires OneCLI installation and configuration

**How to apply (Option A):**
1. Copy `src/credential-proxy.ts` to V2 checkout
2. In V2's `src/container-runner.ts`, in the `wakeContainer()` / `spawnContainer()` function:
   - Remove `onecli.ensureAgent()` and `onecli.applyContainerConfig()` calls
   - Add env vars to container:
     ```typescript
     `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
     // Plus auth placeholder:
     // API key mode: 'ANTHROPIC_API_KEY=placeholder'
     // OAuth mode: 'CLAUDE_CODE_OAUTH_TOKEN=placeholder-oauth-token'
     ```
3. Start proxy in boot sequence: `startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST)`
4. Add to config:
   ```typescript
   export const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
   ```

**Key implementation details:**
- `AuthMode`: `'api-key'` | `'oauth'`
- `detectAuthMode()`: checks `CLAUDE_CODE_OAUTH_TOKEN` → oauth, else `ANTHROPIC_API_KEY` → api-key
- API key mode: injects `x-api-key` header on all proxied requests
- OAuth mode: intercepts `/v1/oauth/token` exchange, replaces placeholder bearer token with real OAuth token, then subsequent requests carry the temporary API key from the exchange response
- Reads secrets via `readEnvFile()` — parses `.env` file directly (never exposes to containers)
- Strips hop-by-hop headers (connection, keep-alive, transfer-encoding)

---

### Security Policy (high risk, becomes V2 module)

**Intent:** Fine-grained container sandboxing: trust-based auth, tool blocking, bash pattern blocking, web fetch restrictions, write protection, readonly overlays, killswitch.

**Current file:** `src/security-policy.ts` (418 lines)

**V2 adaptation:** This should become a Tier 2 optional module under `src/modules/security-policy/`. V2 already has `mount-security` as a Tier 1 default module — our policy is a superset that adds runtime restrictions beyond just mount validation.

**How to apply:**
1. Create `src/modules/security-policy/index.ts`
2. Port the policy loading and rule generation logic
3. Register hooks:
   - Container wake: inject security rules as env vars or mounted JSON
   - Access gate: use policy's trust system alongside V2's permissions module

**Key types:**
```typescript
interface SecurityPolicy {
  trust: { owner_ids: string[]; trusted_members: string[] };
  tools: { blocked: string[]; blocked_untrusted: string[] };
  bash: { blocked_patterns: string[] };  // 52+ default patterns
  webfetch: {
    https_only: boolean;
    blocked_networks: string[];  // loopback, private ranges
    blocked_url_patterns: string[];
    block_secret_values: boolean;
  };
  write: {
    blocked_paths: string[];  // CLAUDE.md, settings.json
    trust_required_paths: string[];  // skills/, *.md
  };
  mounts: {
    readonly_overlays: Array<{ hostPath: string; containerPath: string }>;
  };
  killswitch: { enabled: boolean; message: string };
}

interface ContainerSecurityRules {
  blockedTools: string[];
  blockedBashPatterns: string[];
  webFetchRules: { httpsOnly: boolean; blockedNetworks: string[]; blockedPatterns: string[] };
  writeRules: { blockedPaths: string[]; trustRequiredPaths: string[] };
  senderTrusted: boolean;
}
```

**Config path:** `~/.config/nanoclaw/security-policy.json` (outside project root — tamper-proof)

**52+ default bash blocked patterns include:**
`printenv`, `export`, `/proc/*/environ`, `cat /etc/passwd`, `curl.*metadata`, `wget.*169.254`, `nc -l`, `python -c "import socket"`, etc.

**Integration with V2 container-runner:**
In V2's `spawnContainer()`, after building the mount list and env vars, inject security rules:
```typescript
// Write rules as JSON to session dir, mount readonly
const rulesPath = path.join(sessionDir, 'security-rules.json');
fs.writeFileSync(rulesPath, JSON.stringify(rules));
// Add mount: rulesPath → /workspace/.security-rules.json:ro
```

The container agent-runner reads this file and enforces the rules at the SDK/tool level.

---

### MCP Server (standalone, medium risk)

**Intent:** Paid Nostr MCP server with Lightning payment integration. Exposes nostr signing, publishing, zapping, and profile tools via HTTP/SSE with per-tool pricing and a free tier for NIP-05 registrants.

**Current file:** `src/mcp-server.ts` (1161 lines)

**V2 adaptation:** This is a standalone HTTP server that runs alongside NanoClaw. It doesn't interact with the V2 message flow at all — it just needs to start in the boot sequence.

**How to apply:**
1. Copy `src/mcp-server.ts` to V2 checkout
2. In V2's `src/index.ts` boot sequence, after channels are initialized:
   ```typescript
   if (MCP_SERVER_ENABLED) {
     const { startMcpServer } = await import('./mcp-server.js');
     startMcpServer();
   }
   ```
3. Add config var: `MCP_SERVER_ENABLED = process.env.MCP_SERVER_ENABLED === 'true'`

**Tool pricing (sats):** sign=21, publish=21, post_note=21, fetch_profile=5, zap=50, get_notes=5, create_invoice=5, action_receipt=21, verify_receipt=5

**Free tier:** 200 calls/month for verified NIP-05 registrants (tracked in Cloudflare KV)

**Dependencies:** Nostr signing daemon (Unix socket), NWC wallet (`tools/nwc-wallet/index.js`), Cloudflare KV for usage tracking

---

## Core File Modifications

### Database (src/db.ts → src/db/ in V2)

**V1 customizations to port to V2's DB system:**

1. **Token usage table** — Add as a V2 migration:
   ```sql
   CREATE TABLE IF NOT EXISTS token_usage (
     group_folder TEXT NOT NULL,
     chat_jid TEXT NOT NULL,
     run_at TEXT NOT NULL DEFAULT (datetime('now')),
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX idx_token_usage_group ON token_usage(group_folder);
   CREATE INDEX idx_token_usage_time ON token_usage(run_at);
   ```
   Add `logTokenUsage(groupFolder, chatJid, inputTokens, outputTokens)` function to `src/db/` module.

2. **Quoted message columns** — V2 uses `messages_in.content` JSON blob for message content, which naturally includes quoted context. No separate columns needed. The V1 `quoted_message_id`, `quoted_text`, `quoted_author` columns become JSON fields inside `content`.

3. **Folder UNIQUE constraint fix** — V2 has completely different schema (`agent_groups` table). The old `registered_groups.folder UNIQUE` constraint doesn't exist. The equivalent in V2 is that multiple `messaging_groups` can wire to the same `agent_group` via `messaging_group_agents`. This is solved by design in V2.

4. **Bot message detection** — V2 tracks message direction via `messages_in` (inbound) vs `messages_out` (outbound) tables. No `is_bot_message` flag needed.

5. **Channel and is_group columns on chats** — V2 has `messaging_groups.channel_type` and `messaging_groups.is_group`. Already covered.

### Router (src/router.ts)

**V1 customizations:**

1. **Quoted reply context formatting** — V1 prepends `↩ Replying to [author]: "snippet"` to message body. In V2, this can be done in the channel adapter's `onInbound()` call, encoding the quote context in the `InboundMessage.content` JSON. The container agent-runner handles presenting this context.

2. **Image exfiltration prevention** — V1's `formatOutbound()` strips `![...](...)` and `<img>` tags, replacing with `[image removed]`. In V2, this sanitization should happen in the delivery pipeline — either in `delivery.ts` before calling `adapter.deliver()`, or as a delivery action handler. Add a `sanitizeOutbound(content)` function.

3. **XML escaping** — V1 formats messages as XML for the agent. V2 uses JSON content blobs in session DBs. XML formatting is no longer needed.

### Container Runner (src/container-runner.ts)

**V1 customizations to port to V2's `spawnContainer()`:**

1. **Credential proxy injection** — see Credential Proxy section above

2. **Custom mounts** (add to V2's mount list):
   ```typescript
   // Signal attachments (readonly)
   { hostPath: `${HOME_DIR}/.local/share/signal-cli/attachments/`, containerPath: '/workspace/attachments', readonly: true },

   // White Noise binaries + socket
   { hostPath: `${HOME_DIR}/whitenoise-rs/target/release/wn`, containerPath: '/usr/local/bin/wn', readonly: true },
   { hostPath: `${HOME_DIR}/whitenoise-rs/target/release/wnd`, containerPath: '/usr/local/bin/wnd', readonly: true },
   { hostPath: `${HOME_DIR}/.local/share/whitenoise-cli/release/wnd.sock`, containerPath: '/run/whitenoise/wnd.sock', readonly: false },
   { hostPath: `${HOME_DIR}/.local/share/whitenoise-cli/release/media_cache`, containerPath: '/run/whitenoise/media_cache', readonly: true },

   // Nostr signer socket
   { hostPath: '/run/nostr/signer.sock', containerPath: '/run/nostr/signer.sock', readonly: false },

   // Nostr tools
   { hostPath: `${PROJECT_ROOT}/tools/nostr-signer/clawstr-post.js`, containerPath: '/usr/local/bin/clawstr-post', readonly: true },

   // Proton daemon + CLI (main group only)
   { hostPath: '/run/proton/protond.sock', containerPath: '/run/proton/protond.sock', readonly: false },
   { hostPath: `${HOME_DIR}/.local/bin/pass-cli`, containerPath: '/usr/local/bin/pass-cli', readonly: true },

   // NWC wallet (main group only)
   { hostPath: `${PROJECT_ROOT}/tools/nwc-wallet`, containerPath: '/workspace/tools/nwc-wallet', readonly: true },

   // GitHub CLI (main group only)
   { hostPath: '/usr/bin/gh', containerPath: '/usr/local/bin/gh', readonly: true },

   // System prompt (readonly)
   { hostPath: `${PROJECT_ROOT}/system-prompt.md`, containerPath: '/workspace/system-prompt.md', readonly: true },
   ```

   In V2, many of these should be registered via `containerConfig` on the channel adapter registration. Per-group mounts can go in `groups/<folder>/container.json`.

3. **Host network mode** — V1 uses `--network host` on bare-metal Linux (detected via absence of `/proc/sys/fs/binfmt_misc/WSLInterop`). V2's `container-runtime.ts` already has `hostGatewayArgs()` — verify it handles Linux correctly or port our detection logic.

4. **Main-group-only env vars:**
   ```typescript
   // Only inject for main agent group:
   'GH_TOKEN=<from .env>',
   'AWS_ACCESS_KEY_ID=<from .env>',
   'AWS_SECRET_ACCESS_KEY=<from .env>',
   'AWS_REGION=us-west-1',
   'REMOTION_AWS_BUCKET=<from .env>',
   'REMOTION_SERVE_URL=<from .env>',
   'OPENAI_API_KEY=<from .env>',
   ```

5. **Token usage parsing** — V1 parses `inputTokens` and `outputTokens` from container stdout. V2 doesn't use stdout parsing (session DB instead). Token tracking needs a different approach — either the container agent-runner writes usage to `session_state` table in outbound.db, or we track it from the delivery poll by inspecting `messages_out` metadata.

### Container Runtime (src/container-runtime.ts)

**V1 customizations:**

1. **`--network host` on bare-metal Linux** — Critical for our Surface Pro 7+ setup. The Docker bridge network adds latency and breaks some socket mounts. Detection logic:
   ```typescript
   function isBareMetalLinux(): boolean {
     if (process.platform !== 'linux') return false;
     try {
       fs.accessSync('/proc/sys/fs/binfmt_misc/WSLInterop');
       return false; // WSL, not bare metal
     } catch { return true; } // bare metal Linux
   }

   export function hostGatewayArgs(): string[] {
     return isBareMetalLinux() ? ['--network', 'host'] : ['--add-host', 'host.docker.internal:host-gateway'];
   }

   export const CONTAINER_HOST_GATEWAY = isBareMetalLinux() ? '127.0.0.1' : 'host.docker.internal';
   export const PROXY_BIND_HOST = process.env.PROXY_BIND_HOST || (isBareMetalLinux() ? '127.0.0.1' : '0.0.0.0');
   ```

2. Port to V2: check if V2's `container-runtime.ts` already handles this. If not, add the `isBareMetalLinux()` detection and override `hostGatewayArgs()`.

### IPC (src/ipc.ts — deleted in V2)

**V1 customizations that need V2 equivalents:**

1. **Media attachments** — V1 resolved `/workspace/group/` paths back to host paths, validated against traversal. V2 uses `outbox/` directories in session folders. File attachments in V2 are written by the container to `outbox/{messageId}/{filename}` and read by `readOutboxFiles()` in session-manager.ts. Our path validation logic should move to wherever V2 resolves file paths.

2. **Reactions** — V1 had an IPC message type `{type: "reaction", jid, messageId, emoji}`. In V2, reactions should be encoded as a `messages_out` entry with `kind: "reaction"` and content `{emoji, messageId, targetAuthor}`. The delivery pipeline needs a handler that calls `adapter.sendReaction()` if available.

3. **Image sending** — V1 had `{type: "image", jid, filePath, caption}`. In V2, images are `messages_out` entries with file attachments in the outbox directory. The delivery pipeline reads `message.files` and passes them to `adapter.deliver()`.

4. **Task operations** — V1 IPC supported `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `register_group`, `refresh_groups`. In V2, these become MCP tools registered in the container agent-runner (scheduling module already provides this).

5. **Path traversal protection** — V1's `resolveContainerPath()` validated that resolved paths stay within the group folder. In V2, this validation should happen in session-manager.ts's `extractAttachmentFiles()` and `readOutboxFiles()`.

6. **Size limits** — V1 enforced `MAX_IPC_FILE_SIZE = 1MB` and `MAX_OUTBOUND_MESSAGE_LENGTH = 50000`. Port these to V2's delivery pipeline.

### Index.ts (src/index.ts — completely rewritten in V2)

**V1 customizations that need V2 equivalents:**

1. **Boot sequence additions:**
   - Load security policy → becomes module `setup()` in V2
   - Start credential proxy → add to V2 boot before channel init
   - Init health monitor → add to V2 boot after channel init
   - Start MCP server → add to V2 boot if enabled
   - Wire watch Signal mirror → handle in Watch adapter setup

2. **New contact DM detection** — V1's `checkNewContactDMs()` scanned for unregistered Signal/Nostr contacts and notified admin. In V2, this is handled by the `unknown_sender_policy` on `messaging_groups` + the permissions module. Unknown senders with `request_approval` policy trigger the approval flow automatically.

3. **Killswitch** — V1 checked `securityPolicy.killswitch.enabled` before processing. In V2, this can be a module hook that short-circuits `routeInbound()`.

### Task Scheduler (src/task-scheduler.ts — becomes V2 module)

**V1 customizations:**

1. **Security policy integration** — V1 loaded policy and passed `ContainerSecurityRules` to task containers with `senderTrusted: false`. In V2, this moves to the security policy module's container wake hook.

2. **Orphaned task cleanup** — V1 cleaned up orphaned 'once' tasks (active with null next_run). V2's scheduling module should handle this.

3. **Atomic task claiming** — V1 set `next_run` before dispatch to prevent double-fire on restart. V2's scheduling module should preserve this pattern.

4. **Interval anchor-based drift prevention** — V1's `computeNextRun()` for interval tasks anchors to `task.next_run` (not `now`) to prevent drift on restarts. Port this logic to V2's scheduling module.

---

## External Tools

### Nostr Signer Daemon (`tools/nostr-signer/`)

**Files:** `index.js`, `sessions.js`, `rate-limiter.js`, `clawstr-post.js`, `blossom-upload.js`, `package.json`

**V2 action:** Copy entire `tools/nostr-signer/` directory as-is. No upstream coupling. Mounted into containers via `containerConfig.mounts`.

**Systemd service:** `nostr-signer.service` — reads nsec from kernel keyring, serves Unix socket at `$XDG_RUNTIME_DIR/nostr-signer.sock`

### Protond (`tools/protond/`)

**Files:** `index.js`, `auth.js`, `srp.js`, `srp.test.js`, `package.json`, `package-lock.json`

**V2 action:** Copy as-is. Standalone daemon. Note: Proton `/auth` lockout is an active issue (ticket #4655421).

### Workers (`workers/`)

**Files:** `workers/email-collector/` — Cloudflare Worker for email collection

**V2 action:** Copy as-is. Independent deployment, not part of NanoClaw runtime.

---

## Data Directories (preserved automatically)

These are never touched during migration — they contain user data, state, and configuration:

| Directory | Purpose |
|-----------|---------|
| `groups/` | Agent conversation state, memory, per-group CLAUDE.md |
| `store/` | V1 SQLite database (messages.db), watch uploads |
| `data/` | IPC messages (V1), will contain V2 session DBs |
| `.env` | Environment variables and secrets |
| `~/.config/nanoclaw/` | Security policy, mount allowlist, sender allowlist |
| `~/.local/share/signal-cli/` | Signal daemon state and attachments |
| `~/.local/share/whitenoise-cli/` | White Noise daemon state |

**V1 → V2 data migration:**
- `store/messages.db` is V1's database. V2 creates a new `data/v2.db`. The old database stays for archival/query but is not used by V2 runtime.
- `groups/*/` folders map to V2 `agent_groups` with the same folder names. The mapping: V1 `registered_groups` rows → V2 `agent_groups` + `messaging_groups` + `messaging_group_agents` wiring. This can be automated with a one-time migration script.
- `.env` stays the same. V2 reads the same env vars.

---

## Config Variables (complete list)

All custom environment variables that must be added to V2's `src/config.ts`:

```typescript
// Signal
export const SIGNAL_PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_CLI_TCP_HOST = process.env.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
export const SIGNAL_CLI_TCP_PORT = parseInt(process.env.SIGNAL_CLI_TCP_PORT || '7583', 10);

// White Noise
export const WN_BINARY_PATH = process.env.WN_BINARY_PATH || path.join(HOME_DIR, '.local/bin/wn');
export const WN_SOCKET_PATH = process.env.WN_SOCKET_PATH || path.join(HOME_DIR, '.local/share/whitenoise-cli/release/wnd.sock');
export const WN_ACCOUNT_PUBKEY = process.env.WN_ACCOUNT_PUBKEY || '';

// Nostr DM
export const NOSTR_SIGNER_SOCKET = process.env.NOSTR_SIGNER_SOCKET || '/run/nostr/signer.sock';
export const NOSTR_DM_RELAYS = (process.env.NOSTR_DM_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band').split(',');
export const NOSTR_DM_ALLOWLIST = new Set((process.env.NOSTR_DM_ALLOWLIST || '').split(',').filter(Boolean));

// Watch (T-Watch S3)
export const WATCH_AUTH_TOKEN = process.env.WATCH_AUTH_TOKEN || '';
export const WATCH_HTTP_PORT = parseInt(process.env.WATCH_HTTP_PORT || '3000', 10);
export const WATCH_HTTP_BIND = process.env.WATCH_HTTP_BIND || '0.0.0.0';
export const WATCH_JID = process.env.WATCH_JID || 'watch:device';
export const WATCH_GROUP_FOLDER = process.env.WATCH_GROUP_FOLDER || 'watch';
export const WATCH_SYNC_TIMEOUT_MS = parseInt(process.env.WATCH_SYNC_TIMEOUT_MS || '45000', 10);
export const WATCH_SIGNAL_MIRROR_JID = process.env.WATCH_SIGNAL_MIRROR_JID || '';

// Local Whisper
export const WHISPER_BIN = process.env.WHISPER_BIN ?? path.join(HOME_DIR, '.local/bin/whisper-cli');
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? path.join(HOME_DIR, '.local/share/whisper/models/ggml-base.en.bin');

// Credential Proxy
export const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);

// Security Policy
export const SECURITY_POLICY_PATH = process.env.SECURITY_POLICY_PATH || path.join(HOME_DIR, '.config/nanoclaw/security-policy.json');

// MCP Server
export const MCP_SERVER_ENABLED = process.env.MCP_SERVER_ENABLED === 'true';

// Proton Pass
export const PROTON_PASS_BIN = process.env.PROTON_PASS_BIN || path.join(HOME_DIR, '.local/bin/pass-cli');
export const PROTON_PASS_VAULT = process.env.PROTON_PASS_VAULT || 'NanoClaw';
```

---

## V1 → V2 Group Data Migration Script

A one-time script to populate V2's central DB from V1's `registered_groups` and `chats` tables:

```typescript
// migration-v1-to-v2.ts
// Run once after V2 is set up but before first start
//
// Reads: store/messages.db (V1)
// Writes: data/v2.db (V2 central)
//
// For each V1 registered_group:
//   1. Create agent_group (name, folder)
//   2. Create messaging_group (channel_type from jid prefix, platform_id)
//   3. Create messaging_group_agent wiring (trigger_rules, session_mode)
//   4. Create owner user role for Scott
//
// JID prefix mapping:
//   signal: → channel_type='signal', platform_id=rest
//   whitenoise: → channel_type='whitenoise', platform_id=rest
//   nostr: → channel_type='nostr-dm', platform_id=rest
//   watch: → channel_type='watch', platform_id=rest
```

---

## Verification Checklist

After migration, verify each item:

- [ ] `pnpm install` succeeds
- [ ] `pnpm run build` succeeds (or Bun if applicable)
- [ ] `pnpm test` passes
- [ ] Service starts: `timeout 5 node dist/index.js` reaches "NanoClaw running"
- [ ] Signal channel connects (check logs for "Signal connected")
- [ ] Watch HTTP server responds (curl `http://localhost:3000/api/watch/poll`)
- [ ] White Noise polls work (check logs for WN poll activity)
- [ ] Nostr DM subscribes to relays (check logs)
- [ ] Credential proxy starts on port 3001
- [ ] Security policy loads from `~/.config/nanoclaw/security-policy.json`
- [ ] Container spawns successfully with all mounts
- [ ] Agent responds to a Signal message
- [ ] Agent responds to a Watch message
- [ ] Voice transcription works (send audio via Signal)
- [ ] Reactions work (agent sends emoji reaction)
- [ ] Token usage logged to database
- [ ] Health monitor fires on simulated error
- [ ] MCP server accessible (if enabled)
- [ ] Scheduled tasks execute
- [ ] Watch↔Signal mirror works (if configured)
- [ ] Nostr signing daemon accessible from container
- [ ] Proton tools accessible from main container

---

## Rollback

If V2 migration fails, the V1 code is preserved at:
- Branch: `feat/quad-inbox-deferred`
- Commit: `9d8f8b8f`
- Tag: (will be created at migration start)

All data directories (`groups/`, `store/`, `.env`) are untouched by migration. Rolling back is: `git checkout feat/quad-inbox-deferred && npm install && npm run build && systemctl --user restart nanoclaw`.
